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
   - стрим/печать: DOM и автопрокрутка обновляются не чаще кадра, фон под стеклянными
     панелями статичен (иначе блюры пересчитываются в каждом кадре и интерфейс «жуёт»).
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, ".."); // корень проекта
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

// ── Промпт-диета: что РЕАЛЬНО видит модель ──────────────────────────────────
// Длинные правила переехали в справочники (src/agent-guides) и приходят в запрос
// сами, когда активна группа (GROUP_GUIDES в main.js). Поэтому проверяем
// «эффективный промпт» = SYSTEM_PROMPT + автоподключаемые справочники, а не только
// текст agent-core.js: иначе тест требует вернуть в промпт то, что сознательно убрали.
function autoGuideNames() {
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const m = /const GROUP_GUIDES = \{([^}]*)\}/.exec(mainSrc);
  assert.ok(m, "в main.js нет карты GROUP_GUIDES — справочники групп не подключаются");
  const names = m[1]
    .split(",")
    .map((pair) => (pair.split(":")[1] || "").trim().replace(/["']/g, ""))
    .filter(Boolean);
  assert.ok(names.length >= 4, "GROUP_GUIDES почти пуст: " + m[1]);
  return [...new Set(names)];
}
function modelPrompt() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const parts = [core.SYSTEM_PROMPT || ""];
  for (const n of autoGuideNames()) {
    const file = path.join(ROOT, "src", "agent-guides", n + ".md");
    assert.ok(fs.existsSync(file), "справочник группы \"" + n + "\" не найден: " + file);
    parts.push(fs.readFileSync(file, "utf8"));
  }
  // Markdown-кавычки мешают сверять фразы: убираем их, текст правил не меняем.
  return parts.join("\n").replace(/`/g, "");
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

  // ── Ошибка vision: показываем причину, а не «[object Promise]» ────────────
  // Было: readApiError() (async) вызывалась без await → в текст ошибки попадал промис.
  const realFetchVision = global.fetch;
  await test("analyzeImage/generateImage: ошибка API читаемая, а не «[object Promise]»", async () => {
    const badBody = JSON.stringify({
      error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" },
    });
    global.fetch = async () => ({ ok: false, status: 400, text: async () => badBody, json: async () => JSON.parse(badBody) });
    const cfg = {
      enabled: true,
      url: "https://generativelanguage.googleapis.com/v1beta/openai",
      key: "k",
      visionModel: "gemini-2.0-flash-001",
      imageModel: "img",
    };
    try {
      await assert.rejects(
        () => core.describeImageRemote(cfg, "data:image/png;base64,AA==", "что тут?", "gemini-2.0-flash-001"),
        (e) => {
          assert.ok(e instanceof Error, "брошен не Error");
          assert.ok(!/\[object Promise\]/.test(e.message), "снова [object Promise]: " + e.message);
          assert.ok(/API key not valid/.test(e.message), "нет причины из ответа API: " + e.message);
          return true;
        }
      );
      await assert.rejects(
        () => core.generateImageRemote(cfg, "кот", "img"),
        (e) => {
          assert.ok(!/\[object Promise\]/.test(e.message), "generateImage снова [object Promise]: " + e.message);
          assert.ok(/API key not valid/.test(e.message), "нет причины из ответа API: " + e.message);
          return true;
        }
      );
    } finally {
      global.fetch = realFetchVision;
    }
  });

  await test("fmtError: промис — «забыт await», объекты и строки читаемы", () => {
    assert.strictEqual(core.fmtError(new Error("ENOENT: no such file or directory")), "ENOENT: no such file or directory");
    assert.ok(/забыт await/.test(core.fmtError(Promise.resolve(1))), "промис не распознан как промис");
    assert.strictEqual(core.fmtError("просто строка"), "просто строка");
    assert.ok(core.fmtError({ code: 400 }).includes("400"), "объект не сериализован");
    assert.strictEqual(core.fmtError(undefined), "undefined");
  });

  await test("auxConfig: база Gemini приводится к OpenAI-совместимому /v1beta/openai", () => {
    const g1 = core.auxConfig({ visionEnabled: true, visionUrl: "https://generativelanguage.googleapis.com/v1", visionModel: "gemini-2.0-flash-001" });
    assert.strictEqual(g1.url, "https://generativelanguage.googleapis.com/v1beta/openai");
    const g2 = core.auxConfig({ visionEnabled: true, visionUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", visionModel: "m" });
    assert.strictEqual(g2.url, "https://generativelanguage.googleapis.com/v1beta/openai");
    const other = core.auxConfig({ visionEnabled: true, visionUrl: "https://api.openai.com/v1", visionModel: "gpt-4o-mini" });
    assert.strictEqual(other.url, "https://api.openai.com/v1", "чужая база изменена");
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
    await test("yc: адреса сервисов — logging/logGroups и SES-путь Postbox", async () => {
      const lg = yc.SERVICES.find((s) => s.key === "logging");
      assert.strictEqual(lg.listPath, "/logging/v1/logGroups", "неверный путь лог-групп");
      const f = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} }; // нет списка эндпоинтов → фолбэк
        if (url.includes("/iam/v1/tokens")) return { body: iamBody() };
        return { body: { Identities: [] } };
      });
      global.fetch = f;
      yc.resetIamCache();
      await yc.listService("oauth", "folder1", yc.serviceByKey("postbox"));
      const url = f.calls.find((u) => u.includes("postbox"));
      assert.ok(/^https:\/\/postbox\.cloud\.yandex\.net\/v2\/email\/identities/.test(url), "неверный адрес Postbox: " + url);
      // folderId у SES-API нет: свои параметры (PageSize), см. отдельный тест.
      assert.ok(!url.includes("folderId="), "SES-запрос получил непонятный ему folderId: " + url);
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
      // Пачка из 3 + не больше одного фонового запроса каталога эндпоинтов.
      assert.ok(f.stats().maxInflight <= 4, "залп запросов: " + f.stats().maxInflight);
      assert.ok(f.calls.filter((u) => u.includes("/endpoints")).length <= 1, "каталог эндпоинтов дёргается повторно");
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
      assert.ok(/номер \[N\] устаревает при любой перерисовке/.test(modelPrompt()), "промпт не предупреждает про номера");
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
    assert.ok(modelPrompt().includes("vaultFill подставляет логин и пароль прямо в форму"), "промпт не направляет агента в vaultFill");

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

  await test("контекст: переполнение показывается честно (>100%), а не «100%»", () => {
    ctx.renderContext({ used: 62000, budget: 50000, percent: 100 });
    assert.strictEqual(dom["ctx-text"].textContent, "🧠 62k / 50k · 124%");
    assert.strictEqual(dom["ctx-fill"].style.width, "100%", "полоска должна упираться в 100%");
    assert.ok(cls.has("danger"), "нет красного при переполнении");
    assert.ok(/БОЛЬШЕ бюджета/.test(dom["ctx-indicator"].title), "нет объяснения переполнения");
    assert.ok(/приблизительная/.test(dom["ctx-indicator"].title), "нет оговорки про оценку");
    assert.ok(/текущий шаг/.test(dom["ctx-indicator"].title), "не сказано, что текущий шаг не сжимается");
    // Без бюджета падаем на присланный процент
    ctx.renderContext({ used: 100, budget: 0, percent: 40 });
    assert.strictEqual(dom["ctx-text"].textContent, "🧠 100 / 0 · 40%");
  });

  await test("контекст: индикатор скрыт по умолчанию (до первого ответа)", () => {
    assert.ok(/\.ctx-indicator \{[\s\S]{0,80}display: none;/.test(cssSrc), "нет скрытого состояния в styles.css");
    assert.ok(/\.ctx-indicator\.visible \{ display: flex; \}/.test(cssSrc), "нет класса visible");
  });

  await test("ход работ: заголовок панели липкий, размышления прокручиваются сами", () => {
    const headRule = (cssSrc.match(/\.work-group\.expanded \.work-head \{[\s\S]{0,300}?\}/) || [])[0] || "";
    assert.ok(/position: sticky/.test(headRule), "заголовок панели действий не липкий — свернуть можно только пролистав наверх");
    assert.ok(/top: 0/.test(headRule), "нет привязки к верху панели");
    assert.ok(/z-index/.test(headRule), "заголовок не поднят над строками действий");
    assert.ok(/background/.test(headRule), "нет плотного фона — строки будут просвечивать сквозь заголовок");
    assert.ok(appSrc.includes("function thinkAutoScroll(body, force)"), "нет автопрокрутки размышлений");
    assert.ok(/thinkAutoScroll\(body\); \/\/ текст вырос/.test(appSrc), "автопрокрутка не вызывается при стриминге");
    assert.ok(/thinkAutoScroll\(body, true\)/.test(appSrc), "разворот блока не показывает конец размышлений");
    assert.ok(appSrc.includes("body.dataset.pinned"), "нет учёта ручной прокрутки пользователя");

    // Поведенчески — на настоящем коде app.js: тянем вниз, но не выдёргиваем
    // пользователя, который сам читает выше.
    const t0 = appSrc.indexOf("function thinkAutoScroll(body, force) {");
    const t1 = appSrc.indexOf("\n  }\n", t0);
    assert.ok(t0 > 0 && t1 > t0, "не нашёл thinkAutoScroll в app.js");
    const thinkAutoScroll = new Function(appSrc.slice(t0, t1 + 4) + "\nreturn thinkAutoScroll;")();
    const mkBody = () => ({ dataset: {}, scrollTop: 0, scrollHeight: 900, clientHeight: 200 });
    const a = mkBody();
    thinkAutoScroll(a);
    assert.strictEqual(a.scrollTop, 900, "текст вырос, а блок не поехал вниз");
    assert.strictEqual(a.dataset.pinned, "1", "не запомнили, что пользователь у конца");
    const b = mkBody();
    b.dataset.pinned = "0"; // пользователь отлистал вверх и читает
    thinkAutoScroll(b);
    assert.strictEqual(b.scrollTop, 0, "выдёргнули пользователя из чтения");
    thinkAutoScroll(b, true);
    assert.strictEqual(b.scrollTop, 900, "принудительная прокрутка (разворот блока) не сработала");
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
  const yc = require(path.join(ROOT, "src", "yandex-cloud.js"));
  const ycSrc = fs.readFileSync(path.join(ROOT, "src", "yandex-cloud.js"), "utf8");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
  // Тот же простой мок сети, что и в yc-тестах выше: считает запросы и «в полёте».
  const makeFetch = (route) => {
    let inflight = 0;
    let maxInflight = 0;
    const calls = [];
    const f = async (url, opts) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      calls.push(String(url));
      try {
        const r = route(String(url), opts) || {};
        if (r.throw) throw r.throw;
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
    // yc CLI принимает в YC_TOKEN/YC_IAM_TOKEN только IAM-токен: OAuth там даёт
    // «The token is invalid», поэтому в env идёт свежий IAM из обмена OAuth→IAM.
    assert.ok(/out\.YC_IAM_TOKEN = iam/.test(main) && /out\.YC_TOKEN = iam/.test(main), "свежий IAM не подставляется");
    assert.ok(!/out\.YC_TOKEN = cfg\.oauth/.test(main), "в YC_TOKEN по-прежнему кладётся OAuth-токен");
    assert.ok(/const iam = ycIamEnvToken\(cfg\)/.test(main), "нет проверки свежести снимка IAM");
    assert.ok(/getIamTokenInfo\(cfg\.oauth\)/.test(main), "IAM берётся без срока жизни");
    assert.ok(/out\.YC_CLOUD_ID = cfg\.cloudId/.test(main), "cloudId не подставляется");
    assert.ok(/out\.YC_FOLDER_ID = cfg\.folderId/.test(main), "folderId не подставляется");
    assert.ok(main.includes("agentEnv = { ...userAgentEnv, ...ycAutoEnv(lastAgentEnvSettings) }"), "окружение не собирается из двух частей");
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
    const full = modelPrompt(); // промпт + автоподключаемый справочник группы cloud (промпт-диета)
    assert.ok(/внутренним API/i.test(full) && /Cloud Logging/.test(full), "в промпте не сказано, что логи идут внутренним API");
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
      const captured = { token: "", svcs: [], read: null };
      const sandbox = {
        yandexCloud: {
          getIamToken: async (t) => {
            captured.token = t;
            return "iam-1";
          },
          endpoint: async (svc) => {
            captured.svcs.push(svc);
            // Разные адреса намеренно разные: REST-группы и gRPC-чтение — разные хосты.
            return svc === "log-reading" ? "https://reader.test" : "https://logging.test";
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
    assert.deepStrictEqual(ok.captured.svcs, ["logging", "log-reading"], "адреса берутся у сервисов logging и log-reading");
    assert.strictEqual(ok.captured.read.baseUrl, "https://logging.test", "группы читаются не с logging");
    assert.strictEqual(ok.captured.read.grpcBaseUrl, "https://reader.test", "записи читаются не с log-reading");
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

  // ── Адреса Cloud Logging разведены: REST-группы ≠ gRPC-чтение ──────────────
  await test("yc-logs: чтение идёт на log-reading, группы — на logging (это два разных хоста)", async () => {
    assert.ok(
      /"log-reading": "https:\/\/reader\.logging\.yandexcloud\.net"/.test(ycSrc),
      "в KNOWN_ENDPOINTS нет log-reading — при недоступном каталоге читать логи нечем"
    );
    assert.ok(/"log-ingestion": "https:\/\/ingester\.logging\.yandexcloud\.net"/.test(ycSrc), "нет log-ingestion");

    // Живой gRPC-сервер отвечает только за «чтение», а список групп приходит из
    // ПОДСТАВНОГО REST (другой адрес) — если бы код послал gRPC на REST-хост, чтения не было бы.
    const resource = Buffer.concat([ycLogs.pbString(1, "serverless.container"), ycLogs.pbString(2, "cont-7")]);
    const entry = Buffer.concat([ycLogs.pbString(1, "u"), ycLogs.pbMessage(2, resource), ycLogs.pbInt(6, 3), ycLogs.pbString(7, "log line")]);
    const respBuf = Buffer.concat([ycLogs.pbString(1, "grp"), ycLogs.pbMessage(2, entry)]);
    let seenAuthority = "";
    const server = http2.createServer();
    server.on("stream", (stream, headers) => {
      seenAuthority = String(headers[":authority"] || "");
      const h = Buffer.alloc(5);
      h.writeUInt8(0, 0);
      h.writeUInt32BE(respBuf.length, 1);
      stream.respond({ ":status": 200, "content-type": "application/grpc+proto", "grpc-status": "0" });
      stream.end(Buffer.concat([h, respBuf]));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    let restUrl = "";
    try {
      const res = await ycLogs.readLogs({
        iamToken: "t",
        baseUrl: "https://logging.api.cloud.yandex.net",
        grpcBaseUrl: "http://127.0.0.1:" + port,
        folderId: "folder-1",
        limit: 5,
        fetchImpl: async (u) => {
          restUrl = String(u);
          return { ok: true, status: 200, text: async () => JSON.stringify({ groups: [{ id: "grp", name: "default" }] }) };
        },
      });
      assert.ok(restUrl.startsWith("https://logging.api.cloud.yandex.net/logging/v1/logGroups"), "группы ушли не на REST-хост: " + restUrl);
      assert.strictEqual(seenAuthority, "127.0.0.1:" + port, "gRPC ушёл не на grpcBaseUrl: " + seenAuthority);
      assert.strictEqual(res.entries.length, 1);
      assert.strictEqual(res.entries[0].message, "log line");
    } finally {
      await new Promise((r) => server.close(r));
    }

    // Известен id группы — REST-запрос за списком не нужен вовсе.
    let restCalls = 0;
    const srv2 = http2.createServer();
    srv2.on("stream", (stream) => {
      const h = Buffer.alloc(5);
      h.writeUInt8(0, 0);
      h.writeUInt32BE(respBuf.length, 1);
      stream.respond({ ":status": 200, "content-type": "application/grpc+proto", "grpc-status": "0" });
      stream.end(Buffer.concat([h, respBuf]));
    });
    await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
    try {
      const res2 = await ycLogs.readLogs({
        iamToken: "t",
        baseUrl: "https://logging.api.cloud.yandex.net",
        grpcBaseUrl: "http://127.0.0.1:" + srv2.address().port,
        folderId: "f",
        logGroupId: "grp-known",
        fetchImpl: async () => {
          restCalls++;
          return { ok: true, status: 200, text: async () => "{}" };
        },
      });
      assert.strictEqual(restCalls, 0, "лишний REST-запрос при известном id группы");
      assert.strictEqual(res2.logGroupId, "grp-known");
      assert.strictEqual(res2.entries.length, 1);
    } finally {
      await new Promise((r) => srv2.close(r));
    }
  });

  await test("yc: catalog не ждётся — первый запрос уходит сразу, каталог догружается в фоне", async () => {
    const realFetch = global.fetch;
    try {
      // Каталог эндпоинтов «висит» — адрес всё равно должен вернуться мгновенно.
      global.fetch = () => new Promise(() => {});
      const t0 = Date.now();
      const guard = () => new Promise((r) => setTimeout(() => r("__timeout__"), 1500));
      const addr = await Promise.race([yc.endpoint("log-reading"), guard()]);
      const ms = Date.now() - t0;
      assert.strictEqual(addr, "https://reader.logging.yandexcloud.net", "адрес: " + addr);
      assert.ok(ms < 600, "endpoint ждал сеть " + ms + " мс");
      // Второй сервис из выверенного списка тоже отдаётся мгновенно.
      const addr2 = await Promise.race([yc.endpoint("log-ingestion"), guard()]);
      assert.strictEqual(addr2, "https://ingester.logging.yandexcloud.net", "адрес: " + addr2);
      // Адрес сервиса, которого нет в KNOWN, и правда требует каталога — в этом и
      // смысл фолбэка, поэтому такой id здесь не проверяем (сеть подделана «висящей»).
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("yc: в env идёт свежий IAM (YC_IAM_TOKEN/YC_TOKEN), OAuth туда не попадает", () => {
    const i0 = mainSrc.indexOf("let ycIamEnv = null; // { token, expiresAtMs, forOauth }");
    const i1 = mainSrc.indexOf("// Пересобрать окружение без сети");
    assert.ok(i0 > 0 && i1 > i0, "не нашёл блок IAM-окружения в main.js");
    const box = { yc: null };
    const mod = new Function(
      "ycConfig",
      mainSrc.slice(i0, i1) + "\nreturn { ycAutoEnv, ycIamEnvToken, setIam: (v) => { ycIamEnv = v; } };"
    )((s) => s);
    const cfg = { oauth: "OAUTH-SECRET", cloudId: "b1g", folderId: "f1" };

    // Пока IAM не получен — переменных с токеном нет вовсе (раньше сюда попадал OAuth).
    const out = mod.ycAutoEnv(cfg);
    assert.strictEqual(out.YC_CLOUD_ID, "b1g");
    assert.strictEqual(out.YC_FOLDER_ID, "f1");
    assert.ok(!("YC_TOKEN" in out), "OAuth утёк в YC_TOKEN");
    assert.ok(!("YC_IAM_TOKEN" in out), "пустой IAM попал в env");

    // Свежий IAM подставляется в оба имени.
    mod.setIam({ token: "IAM-FRESH", expiresAtMs: Date.now() + 3600 * 1000, forOauth: "OAUTH-SECRET" });
    const out2 = mod.ycAutoEnv(cfg);
    assert.strictEqual(out2.YC_IAM_TOKEN, "IAM-FRESH");
    assert.strictEqual(out2.YC_TOKEN, "IAM-FRESH");
    assert.strictEqual(mod.ycIamEnvToken(cfg), "IAM-FRESH");

    // Просроченный — не подставляем (yc CLI сказал бы «The token is invalid»).
    mod.setIam({ token: "IAM-OLD", expiresAtMs: Date.now() - 1000, forOauth: "OAUTH-SECRET" });
    assert.strictEqual(mod.ycIamEnvToken(cfg), "");
    assert.ok(!("YC_IAM_TOKEN" in mod.ycAutoEnv(cfg)), "просроченный IAM ушёл в env");

    // Токен от другого OAuth-аккаунта не используем.
    mod.setIam({ token: "IAM-OTHER", expiresAtMs: Date.now() + 3600 * 1000, forOauth: "ДРУГОЙ" });
    assert.strictEqual(mod.ycIamEnvToken(cfg), "");
  });

  await test("yc: ycInstall пересобирает окружение, а токен продлевается заранее", () => {
    assert.ok(
      /applyAgentEnv\(loadSettings\(\)\);\n          const iamReady/.test(mainSrc),
      "после установки yc CLI окружение не пересобирается"
    );
    assert.ok(/applyAgentEnv\(loadSettings\(\)\);/.test(mainSrc), "нет пересборки окружения в ycInstall");
    assert.ok(/getIamTokenInfo\(cfg\.oauth\)/.test(mainSrc), "main.js не берёт срок жизни IAM");
    assert.ok(/YC_IAM_REFRESH_MARGIN = 5 \* 60 \* 1000/.test(mainSrc), "нет запаса на продление IAM");
    assert.ok(/ycIamTimer\.unref/.test(mainSrc), "таймер продления держит процесс");
    assert.ok(/Date\.now\(\) - ycIamLastTryTs < 60 \* 1000/.test(mainSrc), "нет ограничения частоты обращений к IAM");
    // Тексты (промпт и интерфейс) больше не обещают YC_TOKEN как OAuth.
    assert.ok(/YC_IAM_TOKEN — свежий IAM/.test(coreSrc), "промпт не упоминает YC_IAM_TOKEN");
    assert.ok(!/автоматически \(YC_TOKEN \/ YC_CLOUD_ID/.test(coreSrc), "в промпте остался старый текст про YC_TOKEN");
  });

  await test("yc: Postbox спрашивается как SES v2 (путь, заголовок, диагностика 403)", async () => {
    const pb = yc.serviceByKey("postbox");
    assert.strictEqual(pb.listPath, "/v2/email/identities", "Postbox: неверный путь (был выдуманный /postbox/v1/addresses)");
    assert.strictEqual(pb.listKey, "Identities");
    assert.strictEqual(pb.auth, "subject");
    assert.strictEqual(pb.query, "ses");
    assert.strictEqual(yc.serviceQuery(pb, "folder1"), "?PageSize=100", "SES не понимает folderId/pageSize");

    const realFetch = global.fetch;
    try {
      let seenUrl = "";
      let seenHeaders = {};
      const iamJson = () => ({ iamToken: "t", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      global.fetch = makeFetch((url, opts) => {
        if (url.includes("/endpoints")) return { body: {} };
        if (url.includes("/iam/v1/tokens")) return { body: iamJson() };
        seenUrl = String(url);
        seenHeaders = (opts && opts.headers) || {};
        return { body: { Identities: ["mail.example.ru"] } };
      });
      yc.resetIamCache();
      const r = await yc.listService("oauth", "folder1", pb);
      assert.strictEqual(r.count, 1, "адреса Postbox не разобрались: " + JSON.stringify(r.items));
      assert.strictEqual(r.items[0], "mail.example.ru");
      assert.ok(/^https:\/\/postbox\.cloud\.yandex\.net\/v2\/email\/identities\?PageSize=100$/.test(seenUrl), "URL: " + seenUrl);
      assert.strictEqual(seenHeaders["X-YaCloud-SubjectToken"], "t", "IAM не ушёл в X-YaCloud-SubjectToken");
      assert.ok(!seenHeaders.Authorization, "Postbox не принимает Authorization");

      // 403 объясняется причиной (нужен сервисный аккаунт), а не «Нет доступа».
      global.fetch = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} };
        if (url.includes("/iam/v1/tokens")) return { body: iamJson() };
        return { status: 403, body: { message: "Forbidden" } };
      });
      yc.resetIamCache();
      const err403 = await yc.listService("oauth", "f1", pb).then(() => null, (e) => e);
      assert.ok(err403 && /сервисн[а-яё]*\s+аккаунт/i.test(err403.message), "непонятная ошибка: " + (err403 && err403.message));
      assert.ok(/postbox\.viewer/.test(err403.message), "нет роли в подсказке: " + err403.message);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("yc: сводка быстрее — короткий таймаут без повторов, облака и каталоги параллельно", () => {
    const ycSrc2 = fs.readFileSync(path.join(ROOT, "src", "yandex-cloud.js"), "utf8");
    assert.ok(
      /Object\.assign\(\{ timeoutMs: 12000, retries: 1 \}, opts \|\| \{\}\)/.test(ycSrc2),
      "у дашборда нет короткого таймаута по умолчанию"
    );
    // Последовательный вызов по-прежнему может себе позволить 2 попытки и 25 с.
    assert.ok(/o\.retries == null \? 2 :/.test(ycSrc2), "сломан запасной путь с повторами");
    assert.ok(/async function retryNet\(fn, tries\)/.test(ycSrc2), "нет повторов для облаков/каталогов");
    assert.ok(/listClouds\(cfg\.oauth\);\n    const foldersP = cfg\.cloudId/.test(mainSrc), "облака и каталоги по-прежнему последовательны");
    assert.ok(/await yandexCloud\.getIamToken\(cfg\.oauth\);\n    const cloudsP/.test(mainSrc), "обмен токена не вынесен до параллельных запросов");
    // Каталог эндпоинтов не тормозит запуск.
    assert.ok(/if \(known\) \{\n    primeEndpoints\(\);\n    return known;/.test(ycSrc2) === false || /primeEndpoints\(\)/.test(ycSrc2), "нет фонового прогрева каталога");
    assert.ok(/PRIME_MIN_INTERVAL/.test(ycSrc2), "нет ограничения на частые обращения к каталогу");
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
  const mkHelpers = (findProgram, fsImpl) =>
    new Function("fs", "path", "process", "findProgram", helpers + "; return { normalizeShell, powershellArgs, resolveShell, findGitShell, shellsStatus, shellsBrief };")(
      fsImpl || fs, path, process, findProgram
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

  // ── Оболочки: bash/sh через Git for Windows + справочник shellsStatus ────
  await test("shell: sh и bash находят Git-оболочку и объясняют отсутствие", () => {
    const noShells = mkHelpers(() => ({ found: false, reason: "нет" }), { existsSync: () => false });
    for (const kind of ["bash", "sh"]) {
      const r = noShells.resolveShell("echo hi", kind);
      assert.strictEqual(r.kind, kind);
      assert.ok(r.shellHint.length > 10, "нет подсказки для " + kind + ": «" + r.shellHint + "»");
      assert.ok(r.shellHint.includes(kind), "подсказка не называет оболочку: " + r.shellHint);
      assert.strictEqual(r.shell, kind, "при отсутствии не должно быть молчаливого отката в другую оболочку");
    }
    if (process.platform === "win32") {
      assert.ok(noShells.resolveShell("x", "sh").shellHint.includes("Git for Windows"), "нет совета про Git for Windows для sh");
    }
    // Git-бинарь найден → путь подставляется, подсказки нет, bash идёт с -lc
    const withGit = mkHelpers(
      (n) => (n === "bash" ? { found: true, path: "C:\\Git\\bin\\bash.exe" } : { found: false, reason: "нет" }),
      { existsSync: () => false }
    );
    const rb = withGit.resolveShell("echo $HOME", "bash");
    assert.strictEqual(rb.shell, "C:\\Git\\bin\\bash.exe", "путь Git-оболочки не подставлен: " + rb.shell);
    assert.strictEqual(rb.shellHint, "");
    assert.deepStrictEqual(rb.args, ["-lc", "echo $HOME"]);
    if (process.platform !== "win32") {
      // На Unix sh живёт в /bin/sh — это не ошибка и подсказки быть не должно
      const unixSh = mkHelpers(() => ({ found: false, reason: "нет" }), { existsSync: (p) => p === "/bin/sh" });
      const rs = unixSh.resolveShell("echo hi", "sh");
      assert.strictEqual(rs.shellHint, "", "на Unix /bin/sh не должен считаться отсутствующим");
      assert.ok(/bin\/sh/.test(rs.shell), "нет пути к sh: " + rs.shell);
    }
    assert.strictEqual(noShells.resolveShell("x", "bash").missing, true, "нет флага missing у bash");
    assert.strictEqual(withGit.resolveShell("echo $HOME", "bash").missing, false, "найденный bash помечен отсутствующим");
    const allOk = mkHelpers(() => ({ found: true, path: "/usr/bin/sh" }), { existsSync: () => true });
    assert.strictEqual(allOk.resolveShell("echo hi", "").missing, false, "оболочка по умолчанию не может быть missing");
  });

  await test("shellsStatus: агент видит доступные оболочки и получает советы по установке", () => {
    const win = process.platform === "win32";
    const all = mkHelpers((n) => ({ found: true, path: "/usr/bin/" + n }), { existsSync: () => true });
    const st = all.shellsStatus();
    const kinds = st.map((s) => s.kind);
    const expected = win ? ["cmd", "powershell", "pwsh", "bash", "sh"] : ["sh", "powershell", "pwsh", "bash"];
    assert.deepStrictEqual(kinds, expected, "состав отчёта: " + kinds.join(","));
    assert.strictEqual(st.filter((s) => s.def).length, 1, "должна быть ровно одна оболочка по умолчанию");
    assert.strictEqual(st[0].def, true, "оболочка по умолчанию идёт первой");
    assert.ok(st.every((s) => s.available), "всё найдено, а отчёт говорит иначе: " + JSON.stringify(st));

    const none = mkHelpers(() => ({ found: false, reason: "нет" }), { existsSync: () => false });
    const st2 = none.shellsStatus();
    assert.ok(st2.every((s) => !s.available), "ничего не найдено, а отчёт говорит обратное");
    for (const s of st2) assert.ok(s.hint.length > 5, "нет совета для отсутствующей " + s.kind);

    const brief = all.shellsBrief();
    assert.ok(/^по умолчанию /.test(brief), "строка САММАРИ не начинается с «по умолчанию»: " + brief);
    assert.ok(brief.includes("доступно: "), "нет списка доступного: " + brief);
    assert.ok(brief.includes("powershell"), "в САММАРИ нет powershell");
  });

  await test("shellsStatus: инструмент, промпт, ядро инструментов и САММАРИ проекта согласованы", () => {
    assert.ok(/name: "shellsStatus"/.test(core2), "нет описания инструмента");
    assert.ok(/timeoutCommand, shellsStatus, checkInstalledProgram/.test(core2), "нет в списке инструментов промпта");
    assert.ok(/"shellsStatus",/.test(core2), "нет в ядре инструментов (тесный контекст)");
    assert.ok(/shells_status: "shellsStatus"/.test(core2), "нет алиаса");
    assert.ok(/вызови shellsStatus/.test(modelPrompt()), "промпт не велит проверять доступные оболочки");
    assert.ok(/case "shellsStatus": \{/.test(mainFull), "нет диспетчера в main.js");
    assert.ok(/parts\.push\("Оболочки: " \+ shellsBrief\(\)\)/.test(mainFull), "нет строки оболочек в САММАРИ проекта");
  });

  await test("startBackground: без оболочки честная ошибка, а не «OK, PID undefined»", () => {
    const bg = mainFull.slice(mainFull.indexOf('case "startBackground"'), mainFull.indexOf('case "listBackground"'));
    assert.ok(/if \(bgShell\.missing\)/.test(bg), "нет предпроверки оболочки");
    assert.ok(/фоновый процесс НЕ запущен/.test(bg), "нет понятного текста отказа");
    assert.ok(bg.indexOf("bgShell.missing") < bg.indexOf("bgSpawn("), "предпроверка должна идти до запуска процесса");
    assert.ok(/shellsStatus/.test(bg), "отказ не подсказывает shellsStatus");
    assert.ok(/sh\.missing === true/.test(mainFull), "runTerminalCommand игнорирует флаг missing");
    const H = mkHelpers(() => ({ found: false, reason: "нет" }), { existsSync: () => false });
    assert.strictEqual(H.resolveShell("x", "bash").missing, true, "bash без Git не помечен отсутствующим");
    assert.strictEqual(H.resolveShell("x", "sh").missing, true, "sh без Git не помечен отсутствующим");
    const allOk = mkHelpers(() => ({ found: true, path: "/usr/bin/sh" }), { existsSync: () => true });
    assert.strictEqual(allOk.resolveShell("echo hi", "").missing, false, "оболочка по умолчанию не может быть missing");
    const gitOk = mkHelpers(() => ({ found: true, path: "/usr/bin/bash" }), { existsSync: () => true });
    assert.strictEqual(gitOk.resolveShell("x", "bash").missing, false, "найденная оболочка помечена отсутствующей");
    assert.strictEqual(gitOk.resolveShell("x", "powershell").missing, false, "powershell не блокируется по PATH");
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
    assert.ok(/начни с browserConnect/.test(modelPrompt()), "промпт не объясняет, когда подключаться к своему Chrome");
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
// ── Память диалогов: сжатые памятки контекста по датам ─────────────────────
async function testContextMemory() {
  const store = require(path.join(ROOT, "src", "agent-store.js"));
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
  const preloadSrc = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");

  await test("память: выключено по умолчанию, инструменты, IPC и UI на месте", () => {
    assert.ok(/contextMemory: false,/.test(mainSrc), "нет contextMemory: false (должно быть выключено по умолчанию)");
    assert.ok(/contextMemoryDays: 30/.test(mainSrc), "нет contextMemoryDays");
    assert.ok(/case "memoryList"/.test(mainSrc) && /case "memorySearch"/.test(mainSrc), "нет диспетчера memoryList/memorySearch");
    assert.ok(/onMemo: \(m\) => saveContextMemo\(settings, m, emit\)/.test(mainSrc), "runAi не подключает onMemo");
    assert.ok(/function saveContextMemo\(settings, entry, emit\)/.test(mainSrc), "нет saveContextMemo");
    for (const ch of ["memory:stats", "memory:days", "memory:openDir", "memory:clear"]) {
      assert.ok(mainSrc.includes('ipcMain.handle("' + ch + '"'), "нет IPC " + ch);
    }
    for (const fn of ["memoryStats", "memoryDays", "memoryOpenDir", "memoryClear"]) {
      assert.ok(preloadSrc.includes(fn + ":"), "нет preload." + fn);
    }
    assert.ok(/name: "memoryList"/.test(coreSrc) && /name: "memorySearch"/.test(coreSrc), "нет описаний инструментов");
    assert.ok(/noteDelete, memoryList, memorySearch, (todoWrite, )?checkpointSave/.test(coreSrc), "инструменты не в списке промпта");
    assert.ok(/"memoryList", "memorySearch",/.test(coreSrc), "память не в ядре инструментов (тесный контекст)");
    assert.ok(/memory_list: "memoryList"/.test(coreSrc), "нет алиасов инструментов");
    assert.ok(htmlSrc.includes('id="s-context-memory"'), "нет галочки в настройках");
    assert.ok(htmlSrc.includes('data-tab="memory"') && htmlSrc.includes('data-tab-body="memory"'), "нет вкладки настроек");
    assert.ok(appSrc.includes('settings.contextMemory = !!$("s-context-memory").checked'), "галочка не сохраняется");
    assert.ok(appSrc.includes("renderMemoryStatus"), "нет отображения статуса памяти");
  });

  await test("память: сохранение, список дней, чтение и поиск", () => {
    const ud = tmpdir("ctxmem-");
    const r1 = store.contextMemorySave(ud, {
      ts: new Date(2026, 8, 5, 14, 3, 0).getTime(),
      memo: "Мы делали деплой в Yandex Cloud и починили ycLogs.",
      messages: [
        { role: "user", content: "задеплой контейнер" },
        { role: "assistant", content: "готово, URL получен", tool_calls: [{ function: { name: "ycDeploy" } }] },
      ],
      provider: "openai",
      model: "gpt-4o",
      workDir: "C:/proj/domofon",
    });
    assert.strictEqual(r1.ok, true, r1.error);
    assert.strictEqual(r1.day, "2026-09-05");
    assert.strictEqual(r1.count, 1);
    store.contextMemorySave(ud, { ts: new Date(2026, 8, 5, 18, 0, 0).getTime(), memo: "Починили Postbox.", messages: [], provider: "openai" });
    store.contextMemorySave(ud, { ts: new Date(2026, 8, 3, 10, 0, 0).getTime(), memo: "Обсуждали браузер и CDP.", messages: [], provider: "anthropic", model: "claude" });

    const days = store.contextMemoryDays(ud);
    assert.deepStrictEqual(days.map((d) => d.date), ["2026-09-05", "2026-09-03"], "дни неверны: " + JSON.stringify(days));
    assert.strictEqual(days[0].count, 2);

    const day = store.contextMemoryRead(ud, "2026-09-05");
    assert.strictEqual(day.ok, true, day.error);
    assert.strictEqual(day.count, 2);
    assert.strictEqual(day.memos[0].time, "18:00", "свежая памятка должна идти первой");
    assert.ok(day.memos[0].memo.includes("Postbox"));
    assert.strictEqual(day.memos[1].messages, 2, "число сжатых сообщений потеряно");
    assert.strictEqual(store.contextMemoryRead(ud, "не-дата").ok, false);

    const search = store.contextMemorySearch(ud, { query: "ycLogs" });
    assert.strictEqual(search.ok, true, search.error);
    assert.strictEqual(search.count, 1);
    assert.strictEqual(search.matches[0].date, "2026-09-05");
    assert.ok(/ycLogs/.test(search.matches[0].snippet), "фрагмент не найден: " + search.matches[0].snippet);
    assert.strictEqual(store.contextMemorySearch(ud, { query: "Починили", date: "2026-09-03" }).count, 0, "фильтр по дате не работает");
    assert.strictEqual(store.contextMemorySearch(ud, { query: "" }).ok, false);
    assert.strictEqual(store.contextMemorySearch(ud, { query: "задеплой" }).count, 1, "поиск не заглядывает в сжатые шаги");

    const md = fs.readFileSync(path.join(store.contextMemoryDir(ud), "2026-09-05", "day.md"), "utf8");
    assert.ok(/# Сжатые памятки контекста за 2026-09-05/.test(md), "нет заголовка day.md");
    assert.ok(md.includes("Мы делали деплой в Yandex Cloud"), "day.md не содержит памятку");
    assert.ok(md.includes("ycDeploy"), "day.md не содержит имён инструментов");
  });

  await test("память: секреты маскируются в памятке и в шагах", () => {
    const ud = tmpdir("ctxmem-sec-");
    const r = store.contextMemorySave(ud, {
      memo: "Ключ sk-proj-abcdefghijklmnopqrstuvwxyz0123 и AIzaSyA1234567890abcdefghijklmnopqrstuvw",
      messages: [{ role: "user", content: "Bearer abcdefghijklmnopqrstuvwxyz123456" }],
      provider: "openai",
    });
    assert.strictEqual(r.ok, true, r.error);
    const text = JSON.stringify(store.contextMemoryRead(ud, r.day));
    assert.ok(!text.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123"), "ключ OpenAI не замаскирован");
    assert.ok(!text.includes("AIzaSyA1234567890abcdefghijklmnopqrstuvw"), "ключ Google не замаскирован");
    assert.ok(!text.includes("abcdefghijklmnopqrstuvwxyz123456"), "Bearer-токен не замаскирован");
    assert.ok(text.includes("[секрет скрыт]"), "нет пометки о маскировке");
    // строки с NUL-байтами и приватные ключи не ломают запись
    const pk = store.redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----");
    assert.ok(!pk.includes("MIIabc"), "приватный ключ не скрыт");
  });

  await test("память: автоочистка старых дней, статистика и ручная очистка", () => {
    const ud = tmpdir("ctxmem-prune-");
    for (let i = 1; i <= 5; i++) {
      store.contextMemorySave(ud, { ts: new Date(2026, 7, i, 12, 0, 0).getTime(), memo: "день " + i, messages: [], provider: "openai" });
    }
    assert.strictEqual(store.contextMemoryDays(ud).length, 5);
    const pr = store.contextMemoryPrune(ud, 2);
    assert.strictEqual(pr.removed, 3, "удалено не то число дней: " + pr.removed);
    assert.deepStrictEqual(store.contextMemoryDays(ud).map((d) => d.date), ["2026-08-05", "2026-08-04"]);

    const st = store.contextMemoryStats(ud);
    assert.strictEqual(st.days, 2);
    assert.strictEqual(st.memos, 2);
    assert.ok(st.bytes > 0, "не посчитан размер");
    assert.strictEqual(st.newest, "2026-08-05");
    assert.strictEqual(st.oldest, "2026-08-04");
    assert.ok(st.dir.includes("context-memory"), "неверная папка: " + st.dir);

    const cl = store.contextMemoryClear(ud, "2026-08-05");
    assert.strictEqual(cl.removedDays, 1);
    assert.strictEqual(cl.removedMemos, 1);
    assert.strictEqual(store.contextMemoryClear(ud, "").removedDays, 1);
    assert.strictEqual(store.contextMemoryDays(ud).length, 0);
    assert.strictEqual(store.contextMemoryStats(ud).days, 0);
    assert.strictEqual(store.contextMemoryClear(ud, "плохо").ok, false);
  });

  await test("память: пустая памятка файлов не создаёт", () => {
    const ud = tmpdir("ctxmem-empty-");
    const r = store.contextMemorySave(ud, { memo: "   ", provider: "openai" });
    assert.strictEqual(r.ok, false);
    assert.ok(!fs.existsSync(store.contextMemoryDir(ud)), "создана пустая папка");
  });

  // ── Хук onMemo в реальном createContextManager ───────────────────────────
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ПАМЯТКА: починили ycLogs и деплой." } }] }),
    };
  };
  try {
    const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
    await test("память: createContextManager зовёт onMemo при сжатии; ошибка хука не ломает сжатие", async () => {
      const big = "строчка контекста ".repeat(120);
      const messages = [{ role: "system", content: "sys" }];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: "user", content: big + " u" + i });
        messages.push({ role: "assistant", content: big + " a" + i });
      }
      messages.push({ role: "user", content: "текущий вопрос" });
      const settings = { provider: "openai", model: "gpt-4o", openaiUrl: "https://example.invalid/v1", openaiApiKey: "k" };
      const got = [];
      const cm = core.createContextManager({ settings, planMode: false, onMemo: (m) => got.push(m) });
      const out = await cm.manage(messages, 4000);
      assert.strictEqual(got.length, 1, "onMemo не вызван (или вызван не раз): " + got.length);
      assert.ok(/ПАМЯТКА/.test(got[0].text), "текст памятки не передан");
      assert.strictEqual(got[0].provider, "openai");
      assert.strictEqual(got[0].model, "gpt-4o");
      assert.ok(Array.isArray(got[0].messages) && got[0].messages.length >= 10, "исходные сообщения не переданы");
      assert.ok(calls.length >= 1, "нет запроса на сжатие");
      assert.ok(Array.isArray(out) && out.length, "manage вернул пусто");
      assert.ok(out.some((m) => String(m.content || "").includes("ПАМЯТКА")), "памятка не попала в контекст");

      const cm2 = core.createContextManager({ settings, planMode: false });
      await cm2.manage(messages, 4000);
      assert.strictEqual(got.length, 1, "вызвался чужой хук");

      const cm3 = core.createContextManager({ settings, planMode: false, onMemo: () => { throw new Error("бум"); } });
      const out3 = await cm3.manage(messages, 4000);
      assert.ok(Array.isArray(out3) && out3.length, "ошибка хука сломала manage");
    });
  } finally {
    global.fetch = realFetch;
  }
}

// ── Каталог Yandex Cloud: сохранение настроек не должно его стирать ────────
// Симптом: интерфейс каталог видит, а агент — нет; помогало «обновить и сохранить»
// дважды. Причина: объект настроек интерфейса, загруженный ДО автовыбора каталога,
// при сохранении приносил пустой ycFolderId и стирал выбор в main.
async function testYcFolderPersistence() {
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");

  const a = mainSrc.indexOf('ipcMain.handle("settings:set"');
  const endMark = "  saveSettings(merged);\n  mobileBridge.applySettings(merged);\n  return merged;\n});";
  const e = a < 0 ? -1 : mainSrc.indexOf(endMark, a);
  assert.ok(a > 0 && e > a, "не нашёл обработчик settings:set в main.js");
  const code = mainSrc.slice(a, e + endMark.length);

  const prevSettings = {
    workingDir: "/proj",
    ycFolderId: "b1g2folder",
    ycFolderName: "prod",
    ycCloudId: "b1g2cloud",
    ycAllowAgentCreate: false,
    ycAllowAgentDelete: false,
    sitePasswords: [{ id: "a" }],
    mailPassword: "secret",
  };
  let handle = null;
  const saved = [];
  new Function(
    "ipcMain", "loadSettings", "normalizeSettings", "applyAgentEnv",
    "applyBrowserSettings", "saveSettings", "mobileBridge", "lastAgentRepoDir",
    code
  )(
    { handle: (ch, cb) => { handle = cb; } },
    () => ({ ...prevSettings }),
    (x) => ({ ...x }),
    () => {},
    () => {},
    (x) => { saved.push(x); },
    { applySettings: () => {} },
    null
  );
  assert.strictEqual(typeof handle, "function", "обработчик settings:set не зарегистрировался");

  await test("настройки: сохранение из интерфейса не стирает каталог Yandex Cloud", () => {
    // Ровно тот случай, из-за которого агент видел «каталог не выбран»:
    // интерфейс присылает свой устаревший объект с пустыми yc-полями.
    const merged = handle(null, {
      workingDir: "/proj",
      ycFolderId: "",
      ycFolderName: "",
      ycCloudId: "",
      ycAllowAgentCreate: true,
      someOther: 1,
    });
    assert.strictEqual(merged.ycFolderId, "b1g2folder", "каталог стёрт сохранением настроек");
    assert.strictEqual(merged.ycFolderName, "prod", "имя каталога стёрто");
    assert.strictEqual(merged.ycCloudId, "b1g2cloud", "облако стёрто");
    assert.strictEqual(merged.someOther, 1, "обычные поля должны сохраняться");
    // Разрешения агента менять можно — они есть в форме
    assert.strictEqual(merged.ycAllowAgentCreate, true, "разрешение агента не применилось");
    // Защита паролей/почты осталась на месте
    assert.deepStrictEqual(merged.sitePasswords, [{ id: "a" }], "sitePasswords затёрты");
    assert.strictEqual(merged.mailPassword, "secret", "mailPassword затёрт");
    // Устаревший, но НЕпустой каталог тоже не должен перебивать актуальный
    const merged2 = handle(null, { ycFolderId: "old-folder", ycFolderName: "old", ycCloudId: "old-cloud" });
    assert.strictEqual(merged2.ycFolderId, "b1g2folder", "устаревший каталог перебил актуальный");
    // И записано это в настройки, а не только возвращено
    assert.strictEqual(saved[saved.length - 1].ycFolderId, "b1g2folder", "в файл ушёл стёртый каталог");
  });

  await test("настройки: актуальный Yandex Cloud попадает в САММАРИ проекта, UI держит синхрон", () => {
    assert.ok(/function ycBriefLine\(s\)/.test(mainSrc), "нет ycBriefLine");
    assert.ok(/const ycLine = ycBriefLine\(loadSettings\(\)\)/.test(mainSrc), "YC-строка читает не свежие настройки");
    assert.ok(/parts\.push\(ycLine\)/.test(mainSrc), "строка YC не попадает в САММАРИ проекта");
    assert.ok(/Yandex Cloud: каталог «/.test(mainSrc), "нет формулировки про каталог");
    assert.ok(/каталог НЕ выбран/.test(mainSrc), "нет строки для случая «каталог не выбран»");
    assert.ok(/settings\.ycFolderId = st\.folderId/.test(appSrc), "UI не синхронизирует каталог из статуса");
    assert.ok(/settings\.ycFolderId = sel\.value/.test(appSrc), "UI не синхронизирует каталог при выборе");
    // Инструменты по-прежнему читают свежие настройки, а не снимок начала ответа
    const ycCases = mainSrc.slice(mainSrc.indexOf('case "ycStatus"'), mainSrc.indexOf('case "ycInstall"'));
    assert.ok(/ycConfig\(loadSettings\(\)\)/.test(ycCases), "yc-инструменты читают устаревший снимок настроек");
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// План работ агента (todoWrite): чистая логика, хранение, панель, связки.
// ─────────────────────────────────────────────────────────────────────────────
async function testPlanPanel() {
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");
  const AgentCore = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  // ── Срез блока плана: чистые функции + отрисовка (без остального приложения) ──
  const p0 = appSrc.indexOf("  // ─────────── План работ (todoWrite):");
  const p1 = appSrc.indexOf("  // ─────────────── Рендер ───────────────", p0);
  assert.ok(p0 > 0 && p1 > p0, "не нашёл блок плана в app.js (маркеры съехали)");
  const planSrc = appSrc.slice(p0, p1);

  // Игрушечный DOM: ровно те свойства, которые нужны панели.
  const mkEl = (tag) => {
    let cls = new Set();
    let html = "";
    const el = {
      tag,
      children: [],
      textContent: "",
      style: {},
      title: "",
      onclick: null,
      appendChild(ch) {
        el.children.push(ch);
        return ch;
      },
      querySelector() {
        return null;
      },
    };
    // className и classList должны быть одним состоянием: панель ставит классы
    // строкой (className) и читает их через classList.contains.
    Object.defineProperty(el, "className", {
      get: () => Array.from(cls).join(" "),
      set: (v) => { cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    });
    Object.defineProperty(el, "innerHTML", {
      get: () => html,
      set: (v) => { html = String(v); if (!v) el.children.length = 0; },
    });
    el.classList = {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
      toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)),
    };
    return el;
  };
  const nodeText = (n) => (n && n.textContent ? n.textContent : "") + " " + ((n && n.children) || []).map(nodeText).join(" ");
  const hosts = {};
  let activeChat = null;

  const deps = {
    $: (id) => (hosts[id] = hosts[id] || mkEl("div")),
    document: { createElement: mkEl },
    getActiveChat: () => activeChat,
    streaming: false,
    sendMessage: () => {},
    autoResize: () => {},
    persistChatsSoon: () => {},
    normalizePlanTasks: AgentCore.normalizePlanTasks,
    TOOL_LABEL: { runCommand: "Команда в терминале", writeFile: "Изменение файла", readFile: "Чтение файла" },
    AgentCore,
  };
  const mod = new Function(
    ...Object.keys(deps),
    planSrc +
      "\nreturn { planProgress, planArchive, planFromModel, planFromText, planTextAdvance, planTextFinish, planRoundStarted, planLinesFromText, planToolOutcome, planRotate, planPending, renderPlanPanel, PLAN_ARCHIVE_LIMIT };"
  )(...Object.values(deps));

  await test("план: инструмент todoWrite есть в ядре, с алиасами и правилом промпта", () => {
    const def = AgentCore.TOOL_DEFINITIONS.find((t) => t.function && t.function.name === "todoWrite");
    assert.ok(def, "нет определения инструмента todoWrite");
    assert.ok(def.function.description.indexOf("ПОЛНЫЙ список") !== -1, "модель не просят присылать полный список");
    assert.strictEqual(def.function.parameters.properties.tasks.type, "array", "нет схемы tasks");
    assert.ok(def.function.parameters.properties.tasks.items, "нет описания элемента tasks");
    // Алиасы: модель называет инструмент по-разному — имя должно нормализоваться.
    for (const a of ["todo_write", "todos", "todo", "plan", "write_plan", "update_plan"]) {
      assert.strictEqual(AgentCore.normalizeToolName(a), "todoWrite", "алиас " + a + " не ведёт к todoWrite");
    }
    // При тесном контексте шлём только ядро — план обязан там быть.
    assert.ok(AgentCore.selectTools(8000).some((t) => t.function.name === "todoWrite"), "todoWrite отсутствует в ядре инструментов");
    // Правило промпта и список доступных инструментов.
    assert.ok(/^32\. План работ \(todoWrite\)/m.test(AgentCore.SYSTEM_PROMPT), "нет правила 32 про план");
    assert.ok(/САМЫМ ПЕРВЫМ вызывай todoWrite/.test(AgentCore.SYSTEM_PROMPT), "правило 32 не требует план до первого инструмента");
    assert.ok(/План НЕ нужен только для одного короткого действия/.test(AgentCore.SYSTEM_PROMPT), "правило 32 не оговаривает исключение для одношаговых задач");
    assert.ok(/todoWrite, checkpointSave/.test(AgentCore.SYSTEM_PROMPT), "todoWrite нет в списке доступных инструментов");
  });

  await test("план: нормализация пунктов (строки, чекбоксы, статусы на русском, лимит)", () => {
    const items = AgentCore.normalizePlanTasks(["- [x] Первый", "1. Второй", { text: "Третий", status: "in progress" }, "   "]);
    assert.strictEqual(items.length, 3, "пункты потерялись: " + JSON.stringify(items));
    assert.strictEqual(items[0].status, "done", "«- [x]» не распознан как готовый пункт");
    assert.strictEqual(items[0].text, "Первый", "маркер списка остался в тексте: " + items[0].text);
    assert.strictEqual(items[2].status, "in_progress", "«in progress» не распознан");
    // Русские и эмодзи-статусы + «ровно один в работе».
    const ru = AgentCore.normalizePlanTasks("✅ Раз\n🔄 Два\n⚠️ Три\n⬜ Четыре\n🔄 Пятый");
    assert.deepStrictEqual(ru.map((i) => i.status), ["done", "in_progress", "failed", "pending", "pending"], "статусы разобраны неверно: " + JSON.stringify(ru.map((i) => i.status)));
    // Мусор и лимит — без исключений.
    assert.deepStrictEqual(AgentCore.normalizePlanTasks(null), []);
    assert.deepStrictEqual(AgentCore.normalizePlanTasks({ tasks: [] }), []);
    assert.deepStrictEqual(AgentCore.normalizePlanTasks([{}, "  "]), []);
    assert.strictEqual(AgentCore.normalizePlanTasks(Array.from({ length: 12 }, (_, i) => "шаг " + i)).length, AgentCore.PLAN_MAX_ITEMS, "лимит пунктов не соблюдён");
    // Дубликаты не должны раздувать список (модели это любят).
    assert.strictEqual(AgentCore.normalizePlanTasks(["a", "a", "A"]).length, 1, "дубликаты не схлопнуты");
  });

  await test("план модели: принимается и заменяется через историю (авто-шагов больше нет)", () => {
    const chat = { id: "c1", messages: [] };
    assert.strictEqual(mod.planFromModel(chat, { tasks: [{ text: "Разобрать", status: "done" }, { text: "Починить", status: "in_progress" }], title: "Задача" }), true);
    assert.strictEqual(chat.plan.source, "model");
    assert.strictEqual(chat.plan.title, "Задача");
    assert.strictEqual(chat.plan.items.length, 2);
    // Мусорный «план» от слабой модели не должен появляться вовсе.
    const junk = { id: "c-junk", messages: [] };
    assert.strictEqual(mod.planFromModel(junk, { tasks: [] }), false);
    assert.strictEqual(junk.plan, undefined);
    // Вызовы инструментов панель больше не наполняют: её питает только todoWrite.
    assert.strictEqual(mod.planToolOutcome(chat, { name: "runCommand" }, true), false, "успех инструмента тронул план модели");
    assert.strictEqual(chat.plan.source, "model");
    assert.strictEqual(chat.plan.items.length, 2, "план модели изменился от вызова инструмента");
    // И чат без плана от работы инструментов плана не получает.
    const bare = { id: "c-bare", messages: [] };
    assert.strictEqual(mod.planToolOutcome(bare, { name: "runCommand" }, false), false);
    assert.strictEqual(bare.plan, undefined, "инструмент создал план без todoWrite");
    // Новый план модели вытесняет прежний — но не теряет его.
    assert.strictEqual(mod.planFromModel(chat, { tasks: ["Только один"] }), true);
    assert.strictEqual(chat.plan.items.length, 1);
    assert.strictEqual(chat.planHistory.length, 1, "прежний план не ушёл в историю");
    assert.strictEqual(chat.planHistory[0].items.length, 2);
    // История не растёт бесконечно.
    for (let i = 0; i < 10; i++) mod.planFromModel(chat, { tasks: ["шаг " + i] });
    assert.strictEqual(chat.planHistory.length, mod.PLAN_ARCHIVE_LIMIT, "история планов не ограничена");
  });

  await test("план модели: упавший шаг помечается ⚠️, успешный статус модели не трогает", () => {
    const chat = { id: "c", messages: [], plan: { source: "model", items: [{ id: "t1", text: "Починить", status: "in_progress", note: "" }] } };
    assert.strictEqual(mod.planToolOutcome(chat, { name: "runCommand" }, false), true, "падение шага не отмечено");
    assert.strictEqual(chat.plan.items[0].status, "failed");
    assert.ok(/не удал/i.test(chat.plan.items[0].note), "нет пояснения к провалу");
    chat.plan.items[0].status = "in_progress";
    assert.strictEqual(mod.planToolOutcome(chat, { name: "runCommand" }, true), false, "успех инструмента правит план модели");
    assert.strictEqual(chat.plan.items[0].status, "in_progress", "статус модели переписан");
  });

  await test("панель плана не наполняется из вызовов инструментов (авто-шагов больше нет)", () => {
    const chat = { id: "c2", messages: [] };
    assert.strictEqual(mod.planToolOutcome(chat, { name: "readFile" }, true), false, "результат инструмента создал план");
    assert.strictEqual(mod.planToolOutcome(chat, { name: "runCommand" }, false), false);
    assert.strictEqual(chat.plan, undefined, "план появился без todoWrite");
    // Прогресс по-прежнему считает и готовое, и провалы — но уже по плану модели.
    const items = [
      { id: "1", text: "Чтение файла", status: "done" },
      { id: "2", text: "Команда в терминале", status: "done" },
      { id: "3", text: "Изменение файла", status: "failed", note: "инструмент вернул ошибку" },
    ];
    const pr = mod.planProgress(items);
    assert.strictEqual(pr.total, 3);
    assert.strictEqual(pr.done, 2);
    assert.strictEqual(pr.failed, 1);
    assert.strictEqual(pr.percent, 100);
    assert.strictEqual(pr.finished, true);
    // Следов авто-режима в интерфейсе не осталось.
    assert.ok(!/planAuto/.test(appSrc), "в app.js остались авто-шаги");
    assert.ok(appSrc.indexOf("план не задан") === -1, "осталась подпись «план не задан»");
    assert.ok(appSrc.indexOf("PLAN_AUTO_MAX") === -1, "остался лимит авто-шагов");
    assert.ok(appSrc.indexOf("plan-hint") === -1, "остался стиль подписи про не заданный план");
    assert.ok(cssSrc.indexOf(".plan-hint") === -1, "мёртвый стиль .plan-hint остался в styles.css");
  });

  await test("поворот плана: завершённый уходит в историю, незавершённый остаётся", () => {
    const model = { messages: [] };
    mod.planFromModel(model, { tasks: [{ text: "A", status: "done" }, { text: "B", status: "pending" }] });
    assert.strictEqual(mod.planRotate(model), false, "незавершённый план сброшен");
    assert.ok(model.plan, "незавершённый план потерян — агент не увидит, что осталось");
    // А завершённый — уходит в историю и уступает место новой задаче.
    model.plan.items[1].status = "done";
    assert.strictEqual(mod.planRotate(model), true);
    assert.strictEqual(model.plan, null);
    assert.strictEqual(model.planHistory.length, 1);
  });

  await test("панель: рисует пункты, счётчик и прогресс; пустой план её скрывает", () => {
    assert.strictEqual(mod.renderPlanPanel(), undefined, "панель без плана не должна падать");
    assert.ok(hosts["plan-panel"].classList.contains("hidden"), "панель без плана не скрыта");
    activeChat = { id: "c3", messages: [], plan: { title: "Починка ycLogs", source: "model", items: [
      { id: "t1", text: "Разобрать логи", status: "done", note: "" },
      { id: "t2", text: "Починить хост", status: "in_progress", note: "" },
      { id: "t3", text: "Прогнать тесты", status: "pending", note: "" },
    ] } };
    mod.renderPlanPanel();
    const host = hosts["plan-panel"];
    assert.ok(!host.classList.contains("hidden"), "панель с планом скрыта");
    const txt = nodeText(host);
    for (const want of ["Починка ycLogs", "Разобрать логи", "Починить хост", "Прогнать тесты", "1/3"]) {
      assert.ok(txt.indexOf(want) !== -1, "в панели нет «" + want + "»");
    }
    // Полоска прогресса: 1 готов из 3 → 33%.
    const fill = host.children[0].children[1].children[0];
    assert.strictEqual(fill.style.width, "33%", "неверная ширина прогресса: " + fill.style.width);
    // Панель раскрыта по умолчанию (пользователь видит шаги сразу).
    assert.ok(host.children[0].classList.contains("expanded"), "панель плана свёрнута по умолчанию");
    // Клик по заголовку сворачивает.
    host.children[0].children[0].onclick({ stopPropagation() {} });
    assert.ok(!hosts["plan-panel"].children[0].classList.contains("expanded"), "клик не свернул панель");
    // Старый авто-план из chats.json (source «auto») панелью не показывается вовсе:
    // панель существует только для плана модели, иначе дублировала бы панель действий.
    activeChat = { id: "c4", messages: [], plan: { source: "auto", items: [{ id: "a1", text: "Команда в терминале", status: "in_progress", note: "" }] } };
    mod.renderPlanPanel();
    assert.ok(hosts["plan-panel"].classList.contains("hidden"), "авто-план всё ещё рисуется панелью");
    assert.strictEqual(hosts["plan-panel"].children.length, 0, "в панели остались строки авто-плана");
  });

  await test("панель: «▶ Выполнить» только для плана из режима плана, «✕» уводит план в историю", () => {
    activeChat = { id: "c5", messages: [{ id: "m1", role: "assistant", content: "план", plan: true }], plan: { source: "model", title: "T", items: [{ id: "t1", text: "A", status: "pending", note: "" }] } };
    mod.renderPlanPanel();
    let head = hosts["plan-panel"].children[0].children[0];
    assert.ok(nodeText(head).indexOf("▶ Выполнить") !== -1, "нет кнопки выполнения плана");
    // План уже выполняется (ответ не помечен режимом плана) — кнопки быть не должно.
    activeChat = { id: "c6", messages: [{ id: "m1", role: "assistant", content: "ок" }], plan: { source: "model", title: "T", items: [{ id: "t1", text: "A", status: "done", note: "" }] } };
    mod.renderPlanPanel();
    head = hosts["plan-panel"].children[0].children[0];
    assert.strictEqual(nodeText(head).indexOf("▶ Выполнить"), -1, "кнопка выполнения висит на обычном ответе");
    // «✕»: план уходит в историю и с экрана.
    const clear = head.children.find((c) => c.className === "plan-clear");
    assert.ok(clear, "нет кнопки очистки плана");
    clear.onclick({ stopPropagation() {} });
    assert.strictEqual(activeChat.plan, null, "план не убран по «✕»");
    assert.strictEqual(activeChat.planHistory.length, 1, "убранный план не сохранён в историю");
    assert.ok(hosts["plan-panel"].classList.contains("hidden"), "панель осталась после очистки");
  });

  await test("план: инструмент связан с интерфейсом (main → событие plan → панель)", () => {
    assert.ok(/case "todoWrite": \{/.test(mainSrc), "в main.js нет обработчика todoWrite");
    assert.ok(/activeEmit\(\{ type: "plan", tasks: planTasks, title: planTitle \}\)/.test(mainSrc), "main.js не отправляет событие plan");
    assert.ok(/normalizePlanTasks\(/.test(mainSrc) && /planSummary\(/.test(mainSrc), "main.js не нормализует план");
    assert.ok(/normalizePlanTasks,\n  planSummary,/.test(mainSrc), "нормализатор не импортирован в main.js");
    assert.ok(/case "plan": \{/.test(appSrc), "интерфейс не обрабатывает событие plan");
    assert.ok(/planFromModel\(chat, ev\)/.test(appSrc), "событие plan не доходит до состояния");
    assert.ok(/if \(planToolOutcome\(chat, ev, toolOk\)\) renderPlanPanel\(\);/.test(appSrc), "tool_result не проверяет фактический провал шага модели");
    assert.ok(/source: "auto"/.test(appSrc) === false, "в app.js осталось создание авто-плана из вызовов инструментов");
    assert.ok(/if \(planRotate\(getActiveChat\(\)\)\) renderPlanPanel\(\);/.test(appSrc), "новый запрос не поворачивает план");
    assert.ok(/renderPlanPanel\(\);\n    const chat = getActiveChat\(\);|renderPlanPanel\(\);/.test(appSrc), "панель не перерисовывается вместе с чатом");
    // Веб-режим: todoWrite работает как структура, а не «недоступно в веб-версии».
    const webIdx = appSrc.indexOf('c.name === "todoWrite"');
    const webElse = appSrc.indexOf('"⚠️ Файловые операции и git недоступны в веб-версии');
    assert.ok(webIdx > 0 && webIdx < webElse, "в веб-режиме todoWrite падает в общий отказ");
  });

  await test("план: контейнер, оформление и хранение на месте", () => {
    assert.ok(/<div id="plan-panel" class="hidden"><\/div>/.test(htmlSrc), "нет контейнера #plan-panel в index.html");
    assert.ok(/\$\("plan-panel"\)/.test(appSrc), "app.js не ищет #plan-panel");
    // Панель стоит ВЫШЕ панели действий (иначе ход работ заслонял бы план).
    assert.ok(htmlSrc.indexOf('id="plan-panel"') < htmlSrc.indexOf('id="work-panel"'), "панель плана не над панелью действий");
    for (const rule of [".plan-group", ".plan-head", ".plan-item.st-done", ".plan-fill", ".plan-group.expanded .plan-body", "#plan-panel.hidden"]) {
      assert.ok(cssSrc.indexOf(rule) !== -1, "нет стиля " + rule);
    }
    // План сохраняется вместе с чатом и чистится при загрузке.
    assert.ok(/if \(c\.plan !== undefined\)/.test(appSrc), "sanitizeChats не проверяет план");
    assert.ok(/Array\.isArray\(c\.plan\.items\)/.test(appSrc), "sanitizeChats не отвергает повреждённый план");
    assert.ok(/c\.planHistory = c\.planHistory\.slice\(0, PLAN_ARCHIVE_LIMIT\)/.test(appSrc), "история планов не ограничивается при загрузке");
  });

  await test("план: написанный текстом («План: 1. …») становится панелью-чеклистом", () => {
    const text = [
      "Пользователь просит создать API-ключ для модели, которая видит картинки.",
      "",
      "План:",
      "1. Проверить, что диалог закрылся",
      "2. Создать проект (No project selected)",
      "3. Включить API Gemini",
      "4. Создать API-ключ в APIs & Services",
      "",
      "Важный момент: ключ — секрет.",
    ].join("\n");
    const chat = { messages: [] };
    assert.strictEqual(mod.planFromText(chat, text), true, "текстовый план не разобран");
    assert.strictEqual(chat.plan.source, "text");
    assert.strictEqual(chat.plan.title, "План");
    assert.strictEqual(chat.plan.items.length, 4, "пункты плана потерялись: " + JSON.stringify(chat.plan.items));
    assert.strictEqual(chat.plan.items[0].text, "Проверить, что диалог закрылся", "маркер «1.» остался в тексте: " + chat.plan.items[0].text);
    assert.strictEqual(chat.plan.items[1].status, "pending", "новый план сразу помечен выполненным");
    // Повторный разбор того же текста ничего не сбрасывает.
    assert.strictEqual(mod.planFromText(chat, text), false, "тот же план пересоздан");
    // Панель показывает его тем же чеклистом, что и план модели.
    activeChat = chat;
    mod.renderPlanPanel();
    const txt = nodeText(hosts["plan-panel"]);
    assert.ok(!hosts["plan-panel"].classList.contains("hidden"), "панель с текстовым планом скрыта");
    assert.ok(txt.indexOf("Создать проект") !== -1, "пункт плана не попал в панель: " + txt);
    assert.ok(txt.indexOf("0/4") !== -1, "нет счётчика готовых пунктов: " + txt);
  });

  await test("план: галочки текстового плана двигает работа (раунд → пункт)", () => {
    const chat = { messages: [], plan: { source: "text", title: "План", items: [
      { text: "A", status: "pending" }, { text: "B", status: "pending" },
    ] } };
    assert.strictEqual(mod.planTextAdvance(chat, true), true, "первый пункт не встал в работу");
    assert.strictEqual(chat.plan.items[0].status, "in_progress");
    assert.strictEqual(mod.planTextAdvance(chat, true), true);
    assert.strictEqual(chat.plan.items[0].status, "done", "раунд не закрыл пункт");
    assert.strictEqual(chat.plan.items[1].status, "in_progress", "следующий пункт не встал в работу");
    assert.strictEqual(mod.planTextAdvance(chat, true), true);
    assert.strictEqual(chat.plan.items[1].status, "done");
    assert.strictEqual(mod.planTextAdvance(chat, true), false, "пункты кончились, а функция двигает галочки");
    // Провал шага отмечает planToolOutcome — текстовый план здесь не исключение.
    const failing = { messages: [], plan: { source: "text", items: [{ text: "A", status: "in_progress" }] } };
    assert.strictEqual(mod.planToolOutcome(failing, { name: "runCommand" }, false), true, "провал текстового плана не отмечен");
    assert.strictEqual(failing.plan.items[0].status, "failed");
    assert.strictEqual(mod.planTextAdvance(failing, false), false, "провал сдвинул галочки вперёд");
    // Финиш запуска закрывает незакрытый пункт.
    const finish = { messages: [], plan: { source: "text", items: [{ text: "A", status: "done" }, { text: "B", status: "in_progress" }] } };
    assert.strictEqual(mod.planTextFinish(finish), true, "финиш не закрыл текущий пункт");
    assert.strictEqual(finish.plan.items[1].status, "done");
    assert.strictEqual(mod.planTextFinish(finish), false);
    // План модели текстовый прогресс не трогает — там статусы ведёт сама модель.
    const model = { messages: [], plan: { source: "model", items: [{ text: "A", status: "pending" }] } };
    assert.strictEqual(mod.planTextAdvance(model, true), false, "текстовый прогресс двигает план модели");
    assert.strictEqual(mod.planTextFinish(model), false);
  });

  await test("план: раунд работы закрывает ровно один пункт (и только у текстового плана)", () => {
    const chat = { messages: [], plan: { source: "text", items: [
      { text: "A", status: "pending" }, { text: "B", status: "pending" }, { text: "C", status: "pending" },
    ] } };
    assert.strictEqual(mod.planRoundStarted(chat, "s1"), true, "раунд s1 не двинул план");
    assert.strictEqual(chat.plan.items[0].status, "in_progress");
    // Тот же сегмент дважды (размышления + текст одного раунда) — второй раз не двигаем.
    assert.strictEqual(mod.planRoundStarted(chat, "s1"), false, "один сегмент посчитан за два раунда");
    assert.strictEqual(chat.plan.items.length, 3);
    assert.strictEqual(mod.planRoundStarted(chat, "s2"), true);
    assert.strictEqual(chat.plan.items[0].status, "done");
    assert.strictEqual(chat.plan.items[1].status, "in_progress");
    // Без сегмента (защита от пустого id) и без плана — тихо ничего не делаем.
    assert.strictEqual(mod.planRoundStarted(chat, ""), false);
    assert.strictEqual(mod.planRoundStarted({ messages: [] }, "s3"), false);
    const model = { messages: [], plan: { source: "model", items: [{ text: "A", status: "pending" }] } };
    assert.strictEqual(mod.planRoundStarted(model, "s4"), false, "раунд двигает план модели");
    assert.strictEqual(model.plan.items[0].status, "pending");
  });

  await test("план: обычный ответ панелью не становится", () => {
    for (const t of [
      "Готово! Сделал три вещи:\n1. Прочитал файл\n2. Поправил баг\n3. Прогнал тесты",
      "План такой: нужно сначала починить сборку, потом проверить.",
      "✅ Готово. Всё работает, ошибок нет.",
      "Разбор:\n- первое\n- второе",
    ]) {
      assert.deepStrictEqual(mod.planLinesFromText(t), [], "обычный текст принят за план: " + t.slice(0, 40));
    }
    const chat = { messages: [] };
    assert.strictEqual(mod.planFromText(chat, "Готово!\n1. Первое\n2. Второе"), false, "перечисление в ответе стало планом");
    assert.strictEqual(chat.plan, undefined, "из обычного ответа появился план");
    assert.strictEqual(mod.planFromText(chat, "План:\n1. Один шаг"), false, "план из одного пункта показан панелью");
    // А блок чекбоксов без заголовка — это план (его и ждёт пользователь).
    const ticks = { messages: [] };
    assert.strictEqual(mod.planFromText(ticks, "✅ Разобрал логи\n⬜ Починил хост\n⬜ Прогнал тесты"), true, "блок чекбоксов не признан планом");
    assert.strictEqual(ticks.plan.items.length, 3);
    assert.strictEqual(ticks.plan.items[0].status, "done", "✅ не стал готовым пунктом");
    assert.strictEqual(ticks.plan.items[1].status, "pending");
  });

  await test("план: настоящий план модели (todoWrite) важнее текстового", () => {
    const chat = { messages: [] };
    mod.planFromText(chat, "План:\n1. Первый шаг\n2. Второй шаг");
    assert.strictEqual(chat.plan.source, "text");
    assert.strictEqual(mod.planFromModel(chat, { tasks: [{ text: "Сделать раз", status: "in_progress" }], title: "Задача" }), true);
    assert.strictEqual(chat.plan.source, "model");
    assert.strictEqual(chat.planHistory.length, 1, "текстовый план не сохранён в историю");
    assert.strictEqual(mod.planFromText(chat, "План:\n1. Другой\n2. Совсем другой"), false, "текст подменил план модели");
  });

  await test("план: текст ответа связан с панелью (chunk → раунд, tool_start, done)", () => {
    assert.ok(/if \(planFromText\(chat, runTextOf\(chat, aMsg\)\)\)/.test(appSrc), "интерфейс не разбирает план, написанный текстом");
    assert.ok(/planRoundStarted\(chat, seg\.id\);/.test(appSrc), "новый раунд ответа не двигает галочки текстового плана");
    assert.ok(/if \(planTextFinish\(chat\)\)/.test(appSrc), "финиш запуска не закрывает шаг текстового плана");
    // Веб-версия: в План-режиме список инструментов больше не пуст — todoWrite доходит до модели.
    assert.ok(/tools: planMode \? AgentCore\.PLAN_MODE_TOOL_DEFINITIONS : AgentCore\.TOOL_DEFINITIONS,/.test(appSrc), "в веб-версии План-режим без todoWrite");
  });

  await test("План-режим: модель получает ровно todoWrite, остальные вызовы не выполняются", () => {
    // Раньше в этом режиме список инструментов был пуст — прислать план структурой
    // модель физически не могла, и панель оставалась пустой до кнопки «▶ Выполнить».
    assert.strictEqual(AgentCore.PLAN_MODE_TOOL_DEFINITIONS.length, 1, "в План-режиме не ровно один инструмент");
    assert.strictEqual(AgentCore.PLAN_MODE_TOOL_DEFINITIONS[0].function.name, "todoWrite", "в План-режиме нет todoWrite");
    // Набор схем теперь собирает роутер: в План-режиме — ровно PLAN_MODE_TOOL_DEFINITIONS,
    // в обычном — routeTools (база + липкие группы).
    assert.ok(/activeTools = PLAN_MODE_TOOL_DEFINITIONS;/.test(mainSrc), "План-режим не получает набор с todoWrite");
    assert.ok(/routeInfo = routeTools\(\{ text: routerTask, sticky: \[\.\.\.stickyGroups\]/.test(mainSrc), "выбор схем не идёт через роутер");
    assert.ok(/const forceAllTools = !!settings\.sendAllTools;/.test(mainSrc), "нет предохранителя C (все инструменты)");
    assert.ok(/tools: activeTools,/.test(mainSrc), "в запрос уходит не activeTools");
    assert.ok(mainSrc.indexOf("tools: planMode ? [] : activeTools") === -1, "осталось старое обнуление инструментов");
    // Исполнение: в этом режиме выполняется только todoWrite, остальное — честный отказ.
    assert.ok(/if \(planMode && c\.name !== "todoWrite"\)/.test(mainSrc), "нет запрета выполнять инструменты в План-режиме");
    assert.ok(/canonical\.push\(\{ role: "tool", tool_call_id: c\.id, content: blocked \}\)/.test(mainSrc), "отказ не возвращается модели");
    assert.ok(/доступен только todoWrite/.test(mainSrc), "режимный текст промпта не обновлён");
    assert.ok(/единственный доступный там инструмент/.test(AgentCore.SYSTEM_PROMPT), "правило 32 не знает про набор План-режима");
  });

  await test("план: битый план в chats.json не мешает запуску (sanitizeChats)", () => {
    // sanitizeChats извлекается ровно как в соседнем тесте и исполняется отдельно,
    // поэтому нормализатор и лимит передаём параметрами.
    const sIdx = appSrc.indexOf("  function sanitizeChats(d) {");
    assert.ok(sIdx > 0, "не нашёл sanitizeChats");
    const rawLines = appSrc.slice(sIdx).split("\n");
    let endLine = -1;
    for (let i = 1; i < rawLines.length; i++) {
      if (rawLines[i] === "  }") { endLine = i; break; }
    }
    const fn = new Function(
      "normalizePlanTasks",
      "PLAN_ARCHIVE_LIMIT",
      rawLines.slice(0, endLine + 1).join("\n") + "\nreturn sanitizeChats;"
    )(AgentCore.normalizePlanTasks, AgentCore.PLAN_MAX_ITEMS);
    const out = fn({
      activeId: "c1",
      chats: [
        { id: "c1", messages: [], plan: { source: "model", title: "T", items: [{ text: "A", status: "done" }, { text: "" }] }, planHistory: [{ items: [1, 2, 3, 4, 5, 6, 7] }, {}, {}, {}, {}, {}, {}] },
        { id: "c2", messages: [], plan: { items: "не массив" } },
        { id: "c3", messages: [] },
        { id: "c4", messages: [], plan: { source: "auto", title: "Ход работы", items: [{ text: "A", status: "done" }] } },
        { id: "c5", messages: [], plan: { source: "text", title: "План", items: [{ text: "A", status: "in_progress" }, { text: "B", status: "pending" }] } },
      ],
    });
    assert.strictEqual(out.chats[0].plan.items.length, 1, "нормализация плана не сработала: " + JSON.stringify(out.chats[0].plan));
    assert.strictEqual(out.chats[0].plan.source, "model");
    assert.strictEqual(out.chats[0].planHistory.length, AgentCore.PLAN_MAX_ITEMS, "история не обрезана");
    assert.strictEqual(out.chats[1].plan, null, "битый план не сброшен");
    assert.strictEqual(out.chats[2].plan, undefined, "чату без плана добавили поле plan");
    assert.strictEqual(out.chats[3].plan, null, "legacy-план «auto» не убран при загрузке");
    assert.strictEqual(out.chats[4].plan.source, "text", "текстовый план выдан за модельный при загрузке");
    assert.strictEqual(out.chats[4].plan.items.length, 2);
  });
}

// ── 1d. Слои поверх страницы: диалоги, force-клик, JS на странице ───────────
// Повод — консоль Google Cloud: чекбокс согласия и «Agree and continue» лежали в
// .cdk-overlay-container, не попадали в карту (диалог дописан в конец <body> и
// отрезался лимитом строк), а клик падал на проверке «элемент под курсором».
// Здесь проверяем поведенчески: карта видит диалог, клик повторяется, JS и HTML
// доступны, помехи закрываются, а юридические согласия сами не подтверждаются.
async function testBrowserOverlays() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  const dom = require(path.join(ROOT, "src", "dom-map.js"));
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
  const AgentCore = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  // ── Мини-DOM с диалогом поверх страницы ──
  const mkEl = (tag, attrs, opts) => {
    const a = Object.assign({}, attrs || {});
    const o = opts || {};
    return {
      tagName: String(tag).toUpperCase(),
      id: a.id || "",
      className: a.class || "",
      innerText: a.__text || "",
      textContent: a.__text || "",
      isContentEditable: false,
      onclick: null,
      disabled: false,
      checked: !!a.__checked,
      shadowRoot: o.shadowRoot || null,
      labels: [],
      __style: o.style || null,
      getAttribute: (n) => (n in a ? a[n] : null),
      setAttribute: (n, v) => { a[n] = v; },
      getBoundingClientRect: () => o.rect || { top: 120, left: 120, bottom: 150, right: 320, width: 200, height: 30 },
      closest: (sel) => (o.closest ? o.closest(String(sel)) : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };
  };
  const transparent = { visibility: "visible", display: "block", opacity: "0", pointerEvents: "auto" };
  const visible = { visibility: "visible", display: "block", opacity: "1", pointerEvents: "auto" };

  // Диалог: контейнер + внутри прозрачная галочка и кнопка согласия.
  const dialogHost = mkEl(
    "div",
    {
      class: "cdk-overlay-pane",
      "aria-label": "Welcome Misha Pimashin",
      __text:
        "Welcome Misha Pimashin! Create and manage your Google Cloud instances. " +
        "You must accept these terms of service to continue. I agree to the Google Cloud Platform Terms of Service",
    },
    {}
  );
  // closest умеет искать по селектору, как настоящий DOM: панель диалога
  // возвращается только на overlay-селектор, на "label" — null (иначе подпись
  // кнопки подменилась бы текстом всего диалога).
  const OVERLAY_RE = /cdk-overlay|\[role=dialog\]|\[role=alertdialog\]|aria-modal|modal|goog-te|skiptranslate/i;
  const inDialog = (sel) => (OVERLAY_RE.test(String(sel || "")) ? dialogHost : null);
  const checkbox = mkEl("input", { type: "checkbox", "aria-label": "I agree to the Terms of Service" }, { style: transparent, closest: inDialog });
  const agreeBtn = mkEl("button", { __text: "Agree and continue" }, { style: visible, closest: inDialog });
  const pageButtons = [];
  for (let i = 0; i < 70; i++) pageButtons.push(mkEl("button", { __text: "Обычная кнопка " + i }, { style: visible }));
  // Кнопка внутри shadow DOM: обычный querySelectorAll её не видит.
  const shadowInner = mkEl("button", { __text: "Внутри веб-компонента" }, { style: visible });
  const shadowHost = mkEl("my-widget", {}, { shadowRoot: { querySelectorAll: () => [shadowInner] }, style: visible });
  const nodes = pageButtons.concat([shadowHost, checkbox, agreeBtn]);

  global.window = {
    __aiAgentRefSeq: 0,
    innerHeight: 900,
    innerWidth: 1400,
    getComputedStyle: (el) => (el && el.__style) || visible,
  };
  global.document = { title: "Google Cloud", querySelectorAll: () => nodes, getElementById: () => null };
  global.location = { href: "https://console.cloud.google.com/" };
  let map = null;
  try {
    await test("карта: диалог поверх страницы виден, помечен и не режется лимитом", async () => {
      map = await bt.collectMap({ evaluate: (fn) => Promise.resolve(fn()) });
      const dlg = map.items.filter((i) => i.inDialog);
      assert.ok(dlg.length >= 2, "элементы диалога не попали в карту: " + JSON.stringify(map.items.slice(0, 3)));
      assert.strictEqual(map.items[0].inDialog, true, "диалог не первым в карте");
      assert.ok(/Welcome Misha/.test(map.items[0].dialogName), "имя диалога не подхвачено: " + map.items[0].dialogName);
      const box = map.items.find((i) => i.type === "checkbox");
      assert.ok(box, "прозрачный чекбокс согласия не найден");
      assert.strictEqual(box.hiddenInput, true, "чекбокс не помечен как скрытый ввод");
      assert.ok(/terms of service/i.test(box.name || ""), "нет имени чекбокса: " + box.name);
      assert.ok(map.items.some((i) => /Agree and continue/.test(i.name || "")), "кнопки согласия нет в карте");
      // Тень: элемент из shadow-root тоже попал в карту.
      assert.ok(map.items.some((i) => /Внутри веб-компонента/.test(i.name || "")), "shadow DOM не обойдён");
      // Сводка слоёв и классификация.
      assert.ok(map.overlays.length >= 1, "нет сводки слоёв");
      assert.strictEqual(bt.overlayKind(map.overlays[0]), "terms", "диалог согласия распознан неверно");
      // Карта для агента: диалог первым, с предупреждением и подсказками.
      const text = dom.formatSnapshot({ items: map.items, url: map.url, title: map.title, limit: 5, filter: "" });
      assert.ok(/Поверх страницы открыт диалог/.test(text), "нет предупреждения о диалоге поверх страницы");
      assert.ok(/скрытый ввод/.test(text), "нет пометки про скрытый ввод");
      const firstRows = text.split("\n").filter((l) => /\be\d+\b/.test(l));
      assert.ok(/Agree and continue/.test(firstRows.slice(0, 4).join(" ")), "кнопка согласия не в начале списка: " + firstRows.slice(0, 4).join(" | "));
    });

    await test("слои: классификация terms / translate / cookie / dialog", () => {
      const cases = [
        [{ name: "Welcome", cls: "cdk-overlay-pane", text: "You must accept these terms of service to continue" }, "terms"],
        [{ name: "", cls: "goog-te-banner-frame skiptranslate", text: "Перевести страницу? Не сейчас" }, "translate"],
        [{ name: "", cls: "", text: "Мы используем cookie. Принять все" }, "cookie"],
        [{ name: "Оплата", cls: "", text: "Введите данные карты" }, "dialog"],
        [{ name: "", cls: "notice", text: "Понятно, закрыть" }, "noise"],
      ];
      for (const [o, want] of cases) {
        assert.strictEqual(bt.overlayKind(o), want, JSON.stringify(o) + " → " + bt.overlayKind(o));
      }
    });

    await test("помехи: закрываются перевод и «Не сейчас», юридическое — нет", () => {
      const clicked = [];
      const trIframe = mkEl("iframe", { class: "goog-te-banner-frame" }, { style: visible });
      trIframe.style = { display: "" };
      const notNow = mkEl("button", { __text: "Не сейчас" }, { style: visible, closest: () => dialogHost });
      const acceptAll = mkEl("button", { __text: "Принять все" }, { style: visible, closest: () => dialogHost });
      const outsideSafe = mkEl("button", { __text: "Закрыть" }, { style: visible, closest: () => null });
      notNow.click = () => clicked.push("Не сейчас");
      acceptAll.click = () => clicked.push("Принять все");
      outsideSafe.click = () => clicked.push("Закрыть-вне-слоя");
      const all = [trIframe, notNow, acceptAll, outsideSafe];
      global.document = {
        title: "T",
        querySelectorAll: (sel) => (String(sel).indexOf("button") >= 0 || String(sel).indexOf("div") >= 0 ? all : trIframe === null ? [] : [trIframe]),
        getElementById: () => null,
      };
      const report = bt.cleanupInPage();
      assert.ok(clicked.indexOf("Не сейчас") >= 0, "безопасная кнопка слоя не нажата: " + JSON.stringify(clicked));
      assert.strictEqual(clicked.indexOf("Принять все"), -1, "нажата юридическая кнопка «Принять все»!");
      assert.strictEqual(clicked.indexOf("Закрыть-вне-слоя"), -1, "нажата кнопка вне слоя поверх страницы");
      assert.ok(/перевода/.test(report.join(" ")), "окно перевода не скрыто: " + report.join("; "));
      assert.ok(trIframe.style.display === "none", "iframe перевода не скрыт");
    });

    await test("подтверждение согласия: отмечает галочку и жмёт кнопку согласия", () => {
      const acted = [];
      const box = mkEl("input", { type: "checkbox" }, { style: transparent, closest: () => dialogHost });
      box.click = () => acted.push("галочка");
      const agree = mkEl("button", { __text: "Agree and continue" }, { style: visible, closest: () => dialogHost });
      agree.click = () => acted.push("agree");
      const disagree = mkEl("button", { __text: "Не согласен" }, { style: visible, closest: () => dialogHost });
      disagree.click = () => acted.push("disagree");
      const outside = mkEl("button", { __text: "Agree" }, { style: visible, closest: () => null });
      outside.click = () => acted.push("outside");
      const boxes = [box];
      const btns = [disagree, agree, outside];
      global.document = {
        title: "T",
        querySelectorAll: (sel) => (String(sel).indexOf("checkbox") >= 0 ? boxes : btns),
        getElementById: () => null,
      };
      const report = bt.acceptTermsInPage();
      assert.ok(acted.indexOf("галочка") >= 0, "галочка согласия не отмечена: " + JSON.stringify(acted));
      assert.ok(acted.indexOf("agree") >= 0, "кнопка согласия не нажата: " + JSON.stringify(acted));
      assert.strictEqual(acted.indexOf("disagree"), -1, "нажата кнопка «Не согласен»");
      assert.strictEqual(acted.indexOf("outside"), -1, "нажата кнопка вне слоя");
      assert.ok(report.length >= 2, "отчёт пуст: " + JSON.stringify(report));
    });
  } finally {
    delete global.window;
    delete global.document;
    delete global.location;
  }

  // ── Клик: перекрытый элемент всё равно нажимается ──
  const mkClickPage = (mode) => {
    const log = { plain: 0, force: 0, dom: 0, mouse: 0 };
    const locator = {
      first() { return this; },
      async count() { return 1; },
      async isVisible() { return true; },
      async scrollIntoViewIfNeeded() {},
      async click(opts) {
        const force = !!(opts && opts.force);
        if (mode === "plain") { log.plain++; return; }
        if (mode === "force") {
          if (!force) { log.plain++; throw new Error('div.cdk-overlay-backdrop intercepts pointer events'); }
          log.force++;
          return;
        }
        if (mode === "dom") { log.plain++; throw new Error("timeout: element is not stable"); }
        throw new Error("совсем не нажимается");
      },
      async evaluate() {
        if (mode === "mouse") throw new Error("element is not attached to the DOM");
        return "div.cdk-overlay-backdrop «Войти»";
      },
      async boundingBox() { return { x: 100, y: 200, width: 80, height: 20 }; },
    };
    const page = {
      url: () => "https://console.cloud.google.com/",
      async title() { return "Console"; },
      locator: () => locator,
      getByRole: () => locator,
      getByText: () => locator,
      getByLabel: () => locator,
      getByPlaceholder: () => locator,
      on() {},
      async goto() {},
      async waitForTimeout() {},
      keyboard: { async press() {}, async insertText() {} },
      mouse: { async click(x, y) { log.mouse++; log.mouseAt = [x, y]; } },
    };
    return { page, log };
  };
  const Module_ = require("module");
  const origRequire = Module_.prototype.require;
  const useFake = (page) => {
    Module_.prototype.require = function (id) {
      if (id === "playwright") {
        return {
          chromium: {
            executablePath: () => "",
            async launch() {
              return { isConnected: () => true, on() {}, async newPage() { return page; }, async close() {} };
            },
            async launchPersistentContext() {
              return { pages: () => [page], on() {}, async newPage() { return page; }, async close() {} };
            },
          },
        };
      }
      return origRequire.apply(this, arguments);
    };
  };
  try {
    bt.setProfileDir("");
    for (const [mode, expect] of [["plain", /обычный клик/], ["force", /force-клик/], ["dom", /клик из DOM/], ["mouse", /клик мышью/]]) {
      const { page, log } = mkClickPage(mode);
      useFake(page);
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      const open = await bt.open({ url: "https://console.cloud.google.com/" });
      assert.ok(/открыта/.test(open), "вкладка не открылась: " + open.slice(0, 80));
      await test("клик (" + mode + "): перекрытый элемент всё равно нажимается", async () => {
        const r = await bt.click({ ref: "e1" });
        assert.ok(expect.test(r), "способ не сработал: " + r.slice(0, 120));
        if (mode === "force") {
          assert.strictEqual(log.force, 1, "force-клик не вызван");
          assert.ok(/cdk-overlay-backdrop/.test(r), "слой-перекрытие не назван: " + r);
        }
        if (mode === "mouse") assert.ok(log.mouse >= 1, "клик мышью по координатам не сделан");
      });
      await bt.close({ tabId: "all" }).catch(() => {});
    }
  } finally {
    Module_.prototype.require = origRequire;
    await bt.stop().catch(() => {});
    bt.setPlaywright(null);
  }

  // ── JS и HTML на странице ──
  const mkEvalPage = (handler) => ({
    url: () => "https://x.ru/",
    async title() { return "T"; },
    locator: () => ({ first() { return this; }, async count() { return 1; }, async isVisible() { return true; }, async click() {}, async evaluate() { return ""; } }),
    getByRole: () => ({ first() { return this; }, async count() { return 1; }, async isVisible() { return true; }, async click() {} }),
    on() {},
    async goto() {},
    evaluate: handler,
  });
  try {
    const { page, log } = (() => {
      const calls = [];
      return { page: mkEvalPage(async (fn, arg) => { calls.push({ fn, arg }); return "ЗАГОЛОВОК"; }), log: calls };
    })();
    useFake(page);
    bt.setPlaywright(null);
    await bt.stop().catch(() => {});
    await bt.open({ url: "https://x.ru/" });
    await test("browserEval: выражение оборачивается в return, результат отдаётся текстом", async () => {
      const r = await bt.evalJs({ script: "document.title" });
      assert.ok(/ЗАГОЛОВОК/.test(r), "результат не вернулся: " + r);
      assert.ok(/return \(document\.title\);/.test(String(log[log.length - 1].fn)), "выражение не обёрнуто в return: " + log[log.length - 1].fn);
      const code = await bt.evalJs({ script: "const a = 1; return a + 1;" });
      assert.ok(/return a \+ 1;/.test(String(log[log.length - 1].fn)), "код со своим return переписан: " + log[log.length - 1].fn);
      assert.ok(!/return \(const/.test(String(log[log.length - 1].fn)), "код со своим return обёрнут повторно");
      assert.ok(/укажи script/.test(await bt.evalJs({})), "пустой script не объяснён");
    });
    await test("browserDOM: HTML элемента, лимит и «не найдено»", async () => {
      useFake(mkEvalPage(async (fn, arg) => {
        global.document = {
          querySelector: (s) => (s === ".cdk-overlay-pane" ? { outerHTML: "<div class=\"cdk-overlay-pane\">x</div>", innerText: "Диалог", tagName: "DIV" } : null),
          querySelectorAll: () => [{}, {}],
        };
        try {
          return fn(arg);
        } finally {
          delete global.document;
        }
      }));
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://x.ru/" });
      const r = await bt.domHtml({ selector: ".cdk-overlay-pane", limit: 500 });
      assert.ok(/cdk-overlay-pane/.test(r) && /Диалог/.test(r), "HTML не вернулся: " + r.slice(0, 120));
      assert.ok(/совпадений на странице: 2/.test(r), "нет количества совпадений: " + r.slice(0, 160));
      const miss = await bt.domHtml({ selector: ".нет-такого" });
      assert.ok(/ничего не нашлось/.test(miss), "промах не объяснён: " + miss);
      assert.ok(/укажи selector/.test(await bt.domHtml({})), "пустой аргумент не объяснён");
      // shadow DOM: обычный querySelector не находит, поиск уходит внутрь корня
      useFake(mkEvalPage(async (fn, arg) => {
        const inner = { outerHTML: "<button>В тени</button>", tagName: "BUTTON", innerText: "В тени" };
        const host = { shadowRoot: { querySelector: (s) => (s === ".in-shadow" ? inner : null), querySelectorAll: () => [] } };
        global.document = {
          querySelector: () => null,
          querySelectorAll: (s) => (s === "*" ? [host] : []),
        };
        try {
          return fn(arg);
        } finally {
          delete global.document;
        }
      }));
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://x.ru/" });
      const shadow = await bt.domHtml({ selector: ".in-shadow" });
      assert.ok(/В тени/.test(shadow), "shadow DOM не обойдён: " + shadow.slice(0, 140));
    });
    await test("browserOverlays: согласие не подтверждается само, помехи — по флагу", async () => {
      const cleanupCalls = [];
      useFake(mkEvalPage(async (fn) => {
        if (String(fn.name).indexOf("cleanup") >= 0) { cleanupCalls.push(1); return ["нажато «не сейчас»"]; }
        if (String(fn.name).indexOf("acceptTerms") >= 0) { cleanupCalls.push(2); return ["отмечена галочка"]; }
        return {
          url: "https://console.cloud.google.com/",
          title: "Console",
          items: [
            { ref: "e1", tag: "input", type: "checkbox", roleAttr: "", text: "", ariaLabel: "I agree to the Terms of Service", checked: false, inDialog: true, dialogName: "Welcome", hiddenInput: true, inViewport: true, cls: "cdk-overlay-pane-input" },
          ],
          overlays: [{ name: "Welcome", text: "You must accept these terms of service to continue", cls: "cdk-overlay-pane", tag: "div" }],
        };
      }));
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://console.cloud.google.com/" });
      const plain = await bt.overlays({});
      assert.ok(/юридическое согласие/i.test(plain), "нет предупреждения про юридическое согласие: " + plain.slice(0, 200));
      assert.ok(cleanupCalls.indexOf(1) === -1, "помехи закрыты без флага dismiss");
      assert.ok(cleanupCalls.indexOf(2) === -1 && !/Подтверждение согласия/.test(plain), "согласие подтверждено само!");
      const dismissed = await bt.overlays({ dismiss: true });
      assert.ok(cleanupCalls.indexOf(1) >= 0, "dismiss не вызвал очистку помех");
      assert.ok(/Закрытие помех/.test(dismissed), "нет отчёта о закрытии помех: " + dismissed.slice(0, 200));
      const accepted = await bt.overlays({ acceptTerms: true });
      assert.ok(cleanupCalls.indexOf(2) >= 0, "acceptTerms не сработал");
      assert.ok(/Подтверждение согласия/.test(accepted), "нет отчёта о подтверждении: " + accepted.slice(0, 200));
    });
    await test("карта: помехи и юридическое согласие видны даже без элементов в слое", async () => {
      useFake(mkEvalPage(async () => ({
        url: "https://console.cloud.google.com/",
        title: "Console",
        items: [],
        overlays: [
          { name: "", cls: "goog-te-banner-frame skiptranslate", text: "Перевести страницу? Не сейчас", tag: "iframe" },
          { name: "Welcome", cls: "cdk-overlay-pane", text: "You must accept these terms of service to continue", tag: "div" },
        ],
      })));
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://console.cloud.google.com/" });
      const text = await bt.snapshot({});
      assert.ok(/Поверх страницы помехи: окно перевода Google/.test(text), "нет предупреждения о помехе: " + text.slice(0, 220));
      assert.ok(/browserOverlays \{ dismiss: true \}/.test(text), "нет подсказки убрать помеху");
      assert.ok(/юридического согласия/.test(text), "нет предупреждения о согласии: " + text.slice(0, 260));
      assert.ok(/acceptTerms: true/.test(text), "нет подсказки пройти согласие осознанно");
    });

    await test("browserScreenshot: файл на диске + путь агенту, data URL только по запросу", async () => {
      const png = Buffer.from("89504e470d0a1a0a", "hex");
      const page = mkEvalPage(async () => null);
      page.screenshot = async () => png;
      useFake(page);
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://x.ru/" });
      const dir = path.join(tmpdir("agent-shots-"), "shots");
      const r = await bt.screenshot({ dir });
      assert.ok(/скриншот сохранён/.test(r), "нет подтверждения сохранения: " + r.slice(0, 120));
      // По умолчанию — JPEG (компактнее для vision-модели), PNG остаётся по флагу png:true.
      const m = r.match(/сохранён в файл: (.+\.(?:jpg|png))/);
      assert.ok(m && fs.existsSync(m[1]), "файла нет на диске: " + r.slice(0, 160));
      assert.ok(/\.jpg$/.test(m[1]), "по умолчанию ожидался .jpg: " + m[1]);
      assert.ok(fs.readFileSync(m[1]).equals(png), "содержимое файла не совпало");
      assert.ok(/analyzeImage/.test(r), "нет подсказки про разбор");
      const data = await bt.screenshot({ dir, dataUrl: true });
      assert.ok(/^data:image\/jpeg;base64,/.test(data), "data URL не вернулся (ожидался jpeg): " + data.slice(0, 40));
      // Флаг png: true возвращает PNG-файл и PNG data URL (точное чтение мелкого текста).
      const rp = await bt.screenshot({ dir, png: true });
      const mp = rp.match(/сохранён в файл: (.+\.png)/);
      assert.ok(mp && fs.existsSync(mp[1]), "png: true не дал .png файл: " + rp.slice(0, 160));
      const dp = await bt.screenshot({ dir, png: true, dataUrl: true });
      assert.ok(/^data:image\/png;base64,/.test(dp), "png: true не вернул png data URL");
    });
  } finally {
    Module_.prototype.require = origRequire;
    await bt.stop().catch(() => {});
    bt.setPlaywright(null);
  }

  await test("слои поверх страницы: инструменты, промпт и main.js согласованы", () => {
    for (const t of ["browserEval", "browserDOM", "browserOverlays"]) {
      assert.ok(new RegExp('case "' + t + '": \\{').test(mainSrc), "в main.js нет обработчика " + t);
      assert.ok(coreSrc.indexOf('name: "' + t + '"') !== -1, "нет определения " + t + " в ядре");
      assert.ok(AgentCore.SYSTEM_PROMPT.indexOf(t) !== -1, t + " нет в списке доступных инструментов");
    }
    assert.ok(/browserOverlays \{ dismiss: true \}/.test(modelPrompt()), "промпт не учит закрывать помехи");
    assert.ok(/terms of service\) молча не подтверждай/.test(modelPrompt()), "промпт не запрещает молчаливое согласие");
    assert.ok(/screenshotFile\(Object\.assign\(\{\}, args, \{ dir: shotDir \}\)\)/.test(mainSrc), "скриншот не сохраняется файлом");
    assert.ok(/Vision-модель не ответила/.test(mainSrc), "нет честного сообщения, когда зрение не ответило");
    assert.ok(/activeEmit\(\{ type: "image", path: shot\.path/.test(mainSrc), "скриншот не показывается пользователю");
    for (const a of ["browser_eval", "run_js", "browser_dom", "browser_overlays", "overlays", "dismiss_overlays"]) {
      assert.ok(AgentCore.normalizeToolName(a).indexOf("browser") === 0, "алиас " + a + " не ведёт к браузерному инструменту");
    }
    // Карта не должна терять диалог: сортировка в collectMap + защита в formatSnapshot.
    const btSrc = fs.readFileSync(path.join(ROOT, "src", "browser-tools.js"), "utf8");
    assert.ok(/items\.sort\(\(a, b\) => \(b\.inDialog \? 1 : 0\)/.test(btSrc), "collectMap не поднимает диалог наверх");
    const domSrc = fs.readFileSync(path.join(ROOT, "src", "dom-map.js"), "utf8");
    assert.ok(/const dialogItems = shown\.filter\(\(it\) => it\.inDialog\);/.test(domSrc), "formatSnapshot не защищает диалог от обрезки");
    assert.strictEqual(/app\.js/.test("app.js"), true);
    assert.ok(appSrc.length > 0, "app.js не прочитан");
  });
}

// ── Ускорение агента: батчинг, скриншоты JPEG, порог компакции ──────────────
async function testAgentSpeedups() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const appUiSrc = fs.readFileSync(path.join(ROOT, "src", "app-ui-tools.js"), "utf8");
  const browserSrc = fs.readFileSync(path.join(ROOT, "src", "browser-tools.js"), "utf8");

  await test("батчинг: правило 35 в промпте + параллельный набор read-only инструментов", () => {
    assert.ok(/^35\. БАТЧИНГ/m.test(core.SYSTEM_PROMPT), "в промпте нет правила 35 (батчинг)");
    assert.ok(/ВСЕ СРАЗУ в одном ответе/.test(core.SYSTEM_PROMPT), "правило не просит звать несколько инструментов сразу");
    assert.ok(/параллельн/i.test(core.SYSTEM_PROMPT), "правило не объясняет, что вызовы пойдут параллельно");
    assert.ok(/const PARALLEL_SAFE_TOOLS = new Set\(\[/.test(mainSrc), "нет списка безопасных для параллели инструментов");
    const setStart = mainSrc.indexOf("PARALLEL_SAFE_TOOLS = new Set");
    const block = mainSrc.slice(setStart, mainSrc.indexOf("]);", setStart));
    for (const t of ["readFile", "searchProject", "gitStatus", "gitDiff", "webFetch"]) {
      assert.ok(block.indexOf('"' + t + '"') !== -1, "в PARALLEL_SAFE_TOOLS нет " + t);
    }
    // Писатели и интерактивные инструменты НЕ должны попасть в параллельный набор.
    for (const t of ["writeFile", "editFile", "applyPatch", "runCommand", "askUser", "gitCommit", "gitPush", "createFolder", "startBackground"]) {
      assert.ok(block.indexOf('"' + t + '"') === -1, "писатель " + t + " попал в параллельный набор");
    }
    assert.ok(/calls\.every\(\(c\) => PARALLEL_SAFE_TOOLS\.has\(c\.name\)\)/.test(mainSrc), "нет условия параллельного выполнения");
    assert.ok(/await Promise\.all\(\s*calls\.map/.test(mainSrc), "нет параллельного запуска через Promise.all");
  });

  await test("скриншоты: JPEG по умолчанию, PNG по флагу png:true, mime по расширению", () => {
    assert.ok(/function encodeShot\(/.test(mainSrc) && /toJPEG\(/.test(mainSrc), "нет JPEG-кодирования скриншотов в main.js");
    assert.ok(/wantPng = a\.png === true/.test(mainSrc), "нет флага png:true для точных скриншотов");
    assert.ok(/const IMG_MIME = \{/.test(mainSrc) && /"\.jpg": "image\/jpeg"/.test(mainSrc), "analyzeImage не мапит .jpg → image/jpeg");
    assert.ok(/toJPEG\(/.test(appUiSrc), "appScreenshot не отдаёт JPEG");
    assert.ok(/type: "jpeg", quality/.test(browserSrc), "browserScreenshot не снимает JPEG по умолчанию");
    assert.ok(/r\.mime \|\| "image\/png"/.test(browserSrc), "data URL скриншота браузера не учитывает mime");
  });

  await test("компакция: сжатие с резервом 15% до переполнения", () => {
    // Резерв 15% + честное вычитание схем и системного промпта (иначе индикатор врёт).
    assert.ok(/Math\.floor\(\(budget - toolsWeight - systemWeight\) \* 0\.85\)/.test(mainSrc), "нет резерва 15% в бюджете истории");
    assert.ok(/const systemWeight = estimateTokens\(SYSTEM_PROMPT\);/.test(mainSrc), "системный промпт не вычитается из бюджета");
    assert.ok(/const used = histTokens \+ toolsWeight \+ systemWeight;/.test(mainSrc), "индикатор контекста не учитывает промпт");
  });
  await test("кэш промпта: Claude получает точки кэша, OpenAI-совместимым поле не шлём", () => {
    const tools = [
      { type: "function", function: { name: "a", description: "d", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "b", description: "d", parameters: { type: "object", properties: {} } } },
    ];
    // 1) Anthropic: кэш на system и на последней схеме инструмента (кэширует весь блок tools).
    const anth = JSON.parse(
      core.buildChatRequest(
        { provider: "anthropic", anthropicUrl: "https://api.anthropic.com", anthropicApiKey: "k" },
        {
          model: "claude-sonnet-4",
          messages: [
            { role: "system", content: "СИСТЕМА" },
            { role: "user", content: "hi" },
          ],
          tools,
        }
      ).body
    );
    assert.ok(Array.isArray(anth.system) && anth.system[0].cache_control, "Anthropic: нет точки кэша на system");
    assert.strictEqual(anth.system[0].cache_control.type, "ephemeral", "Anthropic: неверный тип точки кэша");
    assert.strictEqual(anth.system[0].text, "СИСТЕМА", "Anthropic: текст системного промпта потерялся");
    assert.ok(anth.tools[anth.tools.length - 1].cache_control, "Anthropic: нет точки кэша на последнем инструменте");
    assert.ok(!anth.tools[0].cache_control, "Anthropic: лишняя точка кэша на первом инструменте");

    // 2) Обычный OpenAI-совместимый API: поле запрещено — иначе 400.
    const oai = core.buildChatRequest(
      { provider: "openai", openaiUrl: "https://api.openai.com/v1", openaiApiKey: "k" },
      { model: "gpt-4o-mini", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }], tools }
    );
    assert.strictEqual(oai.body.indexOf("cache_control"), -1, "OpenAI получил чужое поле cache_control (будет 400)");

    // 3) OpenRouter: кэш для Claude/Gemini, но не для прочих моделей.
    const orClaude = JSON.parse(
      core.buildChatRequest(
        { provider: "openai", openaiUrl: "https://openrouter.ai/api/v1", openaiApiKey: "k" },
        { model: "anthropic/claude-sonnet-4", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] }
      ).body
    );
    const sysMsg = orClaude.messages[0];
    assert.ok(Array.isArray(sysMsg.content) && sysMsg.content[0].cache_control, "OpenRouter+Claude: нет точки кэша");
    assert.strictEqual(sysMsg.content[0].text, "S", "OpenRouter+Claude: системный текст потерялся");
    const orGpt = core.buildChatRequest(
      { provider: "openai", openaiUrl: "https://openrouter.ai/api/v1", openaiApiKey: "k" },
      { model: "openai/gpt-4o", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] }
    );
    assert.strictEqual(orGpt.body.indexOf("cache_control"), -1, "OpenRouter+GPT получил cache_control");
    // 4) Ollama: ничего лишнего.
    const ollama = core.buildChatRequest(
      { provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" },
      { model: "llama3", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] }
    );
    assert.strictEqual(ollama.body.indexOf("cache_control"), -1, "Ollama получила cache_control");
  });

  await test("ожидание событий: адаптивный опрос вместо фиксированных пауз", () => {
    assert.ok(/async function waitUntil\(fn, timeoutMs, pollMs\)/.test(browserSrc), "нет waitUntil в browser-tools");
    assert.ok(/let findPoll = 80;/.test(browserSrc), "поиск элемента не адаптивный (остались фиксированные 200 мс)");
    assert.ok(/findPoll = Math\.min\(Math\.round\(findPoll \* 1\.6\), FIND_POLL_MS\)/.test(browserSrc), "опрос поиска не растёт до потолка");
    assert.ok(/let poll = 100;/.test(browserSrc), "browserWait не адаптивный (остались фиксированные 400 мс)");
    assert.ok(/await waitUntil\(async \(\) => \{[\s\S]{0,180}?\}, 400, 70\)/.test(browserSrc), "hover не ждёт появления меню событием");
    assert.ok(/const moved = await waitUntil\(async \(\) => \{/.test(browserSrc), "прокрутка колесом ждёт фиксированную паузу");
    assert.ok(!/await sleep\(400\);\s*\n\s*const after = await namesOnPage/.test(browserSrc), "в hover осталась слепая пауза 400 мс");
  });
}


// ── Стрим и печать: работа не чаще одного кадра ────────────────────────────
async function testStreamThrottle() {
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");

  await test("стрим: обработчик chunk рисует через очередь кадра, а не на каждый чанк", () => {
    assert.ok(
      /case "chunk":[\s\S]{0,420}?queueBubbleRender\(chat, seg\)/.test(appSrc),
      "обработчик chunk не использует очередь кадра"
    );
    assert.ok(
      !/case "chunk":[\s\S]{0,420}?b\.innerHTML = msgHtml\(seg\.content\)/.test(appSrc),
      "chunk всё ещё перерисовывает innerHTML на каждый чанк"
    );
    assert.ok(
      /case "thinking":[\s\S]{0,420}?scrollBottomSoon\(\)/.test(appSrc),
      "размышления всё ещё дёргают прокрутку на каждый токен"
    );
  });

  await test("стрим: очередь копит текст и рисует последнее состояние за один кадр", () => {
    const s0 = appSrc.indexOf("  let pinnedToBottom = true;");
    const s1 = appSrc.indexOf("  // ─────────────── Отправка ───────────────");
    assert.ok(s0 > 0 && s1 > s0, "не нашёл блок прокрутки/стрима в app.js");

    const dom = {
      messages: { scrollTop: 0, scrollHeight: 500 },
      "btn-scroll-bottom": { classList: { add() {}, remove() {}, toggle() {} } },
    };
    const $ = (id) => dom[id];
    const msgEls = new Map();
    const msgHtml = (c) => "<p>" + c + "</p>";
    const bubble = { innerHTML: "", classList: { add() {}, remove() {} } };
    msgEls.set("a1", { querySelector: (sel) => (sel === ".bubble" ? bubble : null) });

    const rafQ = [];
    const origRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => { rafQ.push(fn); return rafQ.length; };
    try {
      const api = new Function(
        "$",
        "msgEls",
        "msgHtml",
        appSrc.slice(s0, s1) +
          "\nreturn { queueBubbleRender: queueBubbleRender, scrollBottom: scrollBottom, scrollBottomSoon: scrollBottomSoon };"
      )($, msgEls, msgHtml);

      const seg = { id: "a1", content: "прив" };
      const chat = { messages: [seg] };

      api.queueBubbleRender(chat, seg);
      seg.content = "привет";
      api.queueBubbleRender(chat, seg);
      assert.strictEqual(rafQ.length, 1, "кадр запланирован не один раз: " + rafQ.length);
      assert.strictEqual(bubble.innerHTML, "", "пузырь перерисован до кадра");
      assert.strictEqual(dom.messages.scrollTop, 0, "прокрутка дёрнулась до кадра");

      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(bubble.innerHTML, "<p>привет</p>", "не отрисовано последнее состояние");
      assert.strictEqual(dom.messages.scrollTop, 500, "нет автопрокрутки в кадре");
      assert.strictEqual(rafQ.length, 0, "очередь кадров не очищена");

      // Следующий поток чанков после отрисовки снова планирует ровно один кадр.
      seg.content = "привет!";
      api.queueBubbleRender(chat, seg);
      assert.strictEqual(rafQ.length, 1, "новый кадр не запланирован");
      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(bubble.innerHTML, "<p>привет!</p>");

      // Отложенная прокрутка (размышления) тоже схлопывается в один кадр.
      dom.messages.scrollTop = 0;
      api.scrollBottomSoon();
      api.scrollBottomSoon();
      assert.strictEqual(rafQ.length, 1, "прокрутка планирует больше одного кадра");
      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(dom.messages.scrollTop, 500, "отложенная прокрутка не сработала");
    } finally {
      globalThis.requestAnimationFrame = origRaf;
    }
  });

  await test("печать: высота поля ввода пересчитывается не чаще кадра", () => {
    assert.ok(
      /function autoResize\(\) \{\s*if \(inputResizeRaf\) return;/.test(appSrc),
      "autoResize не откладывается до кадра"
    );
    assert.ok(
      /requestAnimationFrame\(\(\) => \{\s*inputResizeRaf = 0;/.test(appSrc),
      "нет сброса inputResizeRaf внутри кадра"
    );
  });

  await test("фон под стеклянными панелями статичен (иначе блюры пересчитываются каждый кадр)", () => {
    const before = cssSrc.match(/body::before \{[\s\S]*?\n\}/);
    assert.ok(before, "не нашёл body::before в styles.css");
    assert.ok(!/animation:/.test(before[0]), "body::before всё ещё анимируется");
    assert.ok(!/will-change/.test(before[0]), "лишний композитный слой: will-change: transform");

    const bubbleRule = cssSrc.match(/\.msg\.assistant \.bubble \{[^}]*165deg[^}]*\}/);
    assert.ok(bubbleRule, "не нашёл оформление пузыря ответа");
    assert.ok(!/backdrop-filter:\s*blur/.test(bubbleRule[0]), "у пузыря ответа остался backdrop-filter");
  });
}

// ── Скорость работы в браузере: ожидание, фреймы, submit, browserAct ───────
// Слабая/быстрая модель должна делать шаги «сразу», а не искать селекторы:
// инструменты сами ждут появления элемента, ищут его и во вложенных фреймах,
// умеют отправлять Enter вместе с вводом и выполняют цепочку шагов одной командой.
async function testBrowserSpeed() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");

  const mkEl = (o) => Object.assign({ visible: true, text: "", name: "" }, o);

  function fakePage(elements, url) {
    const page = {
      els: elements,
      clicked: [],
      filled: [],
      typed: [],
      keys: [],
      _u: url || "https://site.test/",
      keyboard: {
        async press(k) { page.keys.push(k); },
        async insertText(x) { page.typed.push(x); },
      },
      async goto(u) { page._u = u; },
      async waitForLoadState() {},
      url() { return page._u; },
      async title() { return "Страница"; },
      on() {},
      async close() {},
    };
    const by = (pred) => elements.filter(pred);
    const loc = (list) => ({
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
        if (e.tag === "div") throw new Error("Element is not an <input>");
        page.filled.push({ key: e.key, text: t });
      },
      async selectOption() { throw new Error("did not find option"); },
      async evaluate(fn) { return fn({ options: [] }); },
    });
    page.locator = () => loc([]);
    page.getByRole = (role, o) => loc(by((e) => e.role === role && (!o || !o.name || e.name === o.name)));
    page.getByLabel = (t) => loc(by((e) => e.label === t));
    page.getByPlaceholder = (t) => loc(by((e) => e.placeholder === t));
    page.getByText = (t) => loc(by((e) => e.text === t || e.name === t));
    page.evaluate = async () => ({
      url: page._u,
      title: "Страница",
      items: elements.map((e, i) => ({
        ref: "e" + (i + 1),
        tag: e.tag,
        roleAttr: e.role,
        text: e.text || e.name,
        inViewport: e.visible,
        disabled: false,
      })),
    });
    return page;
  }

  const mainEls = [
    mkEl({ key: "login", tag: "button", role: "button", name: "Войти" }),
    mkEl({ key: "email", tag: "input", role: "textbox", label: "Почта" }),
  ];
  const page = fakePage(mainEls);
  const frame = fakePage([mkEl({ key: "frame-agree", tag: "button", role: "button", name: "Согласен" })], "https://widget.test/frame");
  page.frames = () => [page, frame];
  const mockBrowser = {
    isConnected: () => true,
    on() {},
    async pages() { return [page]; },
    async newPage() { return page; },
    async close() {},
  };

  await bt.close({ tabId: "all" });
  bt.setPlaywright({
    chromium: {
      executablePath: () => "",
      async launch() { return mockBrowser; },
      async launchPersistentContext() { return mockBrowser; },
    },
  });
  try {
    await bt.open({ url: "https://site.test/", newTab: true });

    await test("browserClick: сам ждёт появления элемента (без browserWait и повторов)", async () => {
      page.clicked.length = 0;
      setTimeout(() => mainEls.push(mkEl({ key: "late", tag: "button", role: "button", name: "Поздняя" })), 250);
      const r = await bt.click({ name: "Поздняя", timeout: 2500 });
      assert.ok(/^OK — клик/.test(r), "клик не прошёл по появившейся позже кнопке:\n" + r);
      assert.deepStrictEqual(page.clicked, ["late"]);
    });

    await test("browserClick: находит элемент во вложенном фрейме (iframe)", async () => {
      frame.clicked.length = 0;
      const r = await bt.click({ name: "Согласен" });
      assert.ok(/^OK — клик/.test(r), "элемент во фрейме не найден:\n" + r);
      assert.ok(/фрейм/.test(r), "ответ не сообщает, что элемент был во фрейме:\n" + r);
      assert.deepStrictEqual(frame.clicked, ["frame-agree"]);
    });

    await test("browserFill: submit сразу отправляет Enter (ввёл и отправил одним вызовом)", async () => {
      page.filled.length = 0;
      page.keys.length = 0;
      const r = await bt.fill({ label: "Почта", text: "a@b.c", submit: true });
      assert.ok(/^OK — поле/.test(r), r);
      assert.ok(/отправлено \(Enter\)/.test(r), "нет отметки об отправке:\n" + r);
      assert.deepStrictEqual(page.filled, [{ key: "email", text: "a@b.c" }]);
      assert.deepStrictEqual(page.keys, ["Enter"]);
    });

    await test("browserAct: цепочка шагов одной командой (клик → ввод+Enter → клавиша → пауза → текст)", async () => {
      page.clicked.length = 0;
      page.filled.length = 0;
      page.keys.length = 0;
      const r = await bt.act({
        steps: [
          { click: "Войти" },
          { field: "Почта", text: "b@c.d", submit: true },
          { press: "Escape" },
          { wait: 10 },
          { read: true },
        ],
      });
      assert.ok(/шагов 5 из 5, ок: 5/.test(r), "не все шаги выполнены:\n" + r);
      assert.ok(!/❌/.test(r), "есть сбой на ровном месте:\n" + r);
      assert.deepStrictEqual(page.clicked, ["login"]);
      assert.deepStrictEqual(page.filled, [{ key: "email", text: "b@c.d" }]);
      assert.deepStrictEqual(page.keys, ["Enter", "Escape"]);
    });

    await test("browserAct: первый сбой останавливает цепочку и объясняет причину", async () => {
      page.clicked.length = 0;
      page.keys.length = 0;
      const r = await bt.act({ steps: [{ click: "Кнопки нет" }, { press: "Enter" }] });
      assert.ok(/сбоев: 1/.test(r), "сбой не отражён:\n" + r);
      assert.ok(!/✅ .*Enter/.test(r), "шаги после сбоя всё равно выполнялись:\n" + r);
      assert.deepStrictEqual(page.keys, [], "Enter нажался после сбоя");
      assert.ok(/Похожие элементы|Что вообще есть/.test(r), "нет подсказки с похожими элементами:\n" + r);
    });

    await test("browserAct: без шагов и с мусором — понятная ошибка, а не молчание", async () => {
      const empty = await bt.act({});
      assert.ok(/Ошибка browserAct/.test(empty), empty);
      const junk = await bt.act({ steps: [123, { fill: {} }, { nonsense: 1 }] });
      assert.ok(/шаг не понял|Ошибка/.test(junk), junk);
    });

    await test("browserWait: пауза без элемента (странице нужно время дорисоваться)", async () => {
      const r = await bt.wait({ ms: 10 });
      assert.ok(/пауза 10 мс/.test(r), r);
    });

    await test("browserAct: цепочку можно начать с открытия адреса ({goto})", async () => {
      const r = await bt.act({ steps: [{ goto: "https://other.test/page" }, { snapshot: true }] });
      assert.ok(/шагов 2 из 2, ок: 2/.test(r), "цепочка с goto не прошла:\n" + r);
      assert.ok(/other\.test/.test(r), "в отчёте нет нового адреса:\n" + r);
      assert.strictEqual(page.url(), "https://other.test/page");
    });

    await test("browserAct: подключён к интерфейсу, промпту и подписям инструментов", () => {
      assert.ok(/case "browserAct"/.test(mainSrc), "main.js не обрабатывает browserAct");
      assert.ok(/name: "browserAct"/.test(coreSrc), "нет определения инструмента browserAct");
      assert.ok(/browserAct: "⚡"/.test(appSrc), "нет иконки browserAct в интерфейсе");
      assert.ok(/browserAct: "Цепочка действий в браузере"/.test(appSrc), "нет подписи browserAct");
      assert.ok(/быстрый путь/i.test(modelPrompt()), "в промпте нет блока про быстрый путь");
      assert.ok(/submit: true/.test(coreSrc), "промпт не знает про submit у browserFill");
      assert.ok(/фрейм/.test(coreSrc), "в описаниях нет поиска по фреймам");
    });
  } finally {
    bt.setPlaywright(null);
  }
}

// ── 1e. «Чувства» агента: прокрутка, наведение, сеть, ожидание покоя ────────
// Повод: половина элементов была ЗА ЭКРАНОМ (не видно в карте), меню не
// раскрывались без hover, а после клика агент гадал по DOM, что ответил сервер.
// Проверяем поведенчески на подставном Playwright и мини-DOM страницы.
async function testBrowserSenses() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
  const AgentCore = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  const mkEl = (o) => Object.assign({ visible: true, text: "", name: "", role: "button", tag: "button", inViewport: true }, o);

  function fakePage(elements, url) {
    const page = {
      els: elements,
      wheels: [],
      moves: [],
      handlers: {},
      _u: url || "https://site.test/",
      _scroll: { y: 0, max: 2000, vh: 800 },
      _inner: [],
      _takes: [],
      mouse: {
        async move(x, y) { page.moves.push([x, y]); },
        async wheel(dx, dy) {
          page.wheels.push([dx, dy]);
          page._scroll.y = Math.max(0, Math.min(page._scroll.max, page._scroll.y + dy));
        },
      },
      viewportSize: () => ({ width: 1000, height: 800 }),
      on(type, fn) { (page.handlers[type] = page.handlers[type] || []).push(fn); },
      off(type, fn) {
        const l = page.handlers[type] || [];
        const i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      },
      emit(type) {
        const args = Array.prototype.slice.call(arguments, 1);
        for (const fn of (page.handlers[type] || []).slice()) fn.apply(null, args);
      },
      async goto(u) { page._u = u; },
      async waitForLoadState() {},
      url() { return page._u; },
      async title() { return "Страница"; },
      async close() {},
    };
    const by = (pred) => elements.filter(pred);
    const loc = (list) => ({
      first() { return loc(list.slice(0, 1)); },
      async count() { return list.length; },
      async isVisible() { return !!(list[0] && list[0].visible); },
      async scrollIntoViewIfNeeded() { if (list[0]) list[0].scrolledIn = true; },
      async boundingBox() {
        const e = list[0];
        return e ? { x: 10, y: 20, width: 100, height: 50 } : null;
      },
      async hover() {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (!e.visible) throw new Error("element is not visible");
        e.hovered = true;
        if (e.onHover) e.onHover();
      },
      async click() {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (!e.visible) throw new Error("element is not visible");
      },
      async fill() { if (!list[0]) throw new Error("no element"); },
      async evaluate(fn, arg) { return fn(list[0], arg); },
    });
    page.locator = (sel) => {
      const ref = String(sel).match(/^\[data-agent-ref="([^"]+)"\]$/);
      return loc(ref ? by((e) => e.ref === ref[1]) : []);
    };
    page.getByRole = (role, o) => loc(by((e) => e.role === role && (!o || !o.name || String(e.name).toLowerCase().indexOf(String(o.name).toLowerCase()) >= 0)));
    page.getByLabel = (t) => loc(by((e) => String(e.label || "").toLowerCase().indexOf(String(t).toLowerCase()) >= 0));
    page.getByPlaceholder = (t) => loc(by((e) => String(e.placeholder || "").toLowerCase().indexOf(String(t).toLowerCase()) >= 0));
    page.getByText = (t) => loc(by((e) => String(e.text || e.name).toLowerCase().indexOf(String(t).toLowerCase()) >= 0));
    page.evaluate = async (fn, arg) => {
      if (fn === bt.scrollStateInPage) {
        return { y: page._scroll.y, max: page._scroll.max, vh: page._scroll.vh, docH: page._scroll.max + page._scroll.vh, inner: page._inner };
      }
      if (fn === bt.scrollPageInPage) {
        const before = page._scroll.y;
        page._scroll.y = Math.max(0, Math.min(page._scroll.max, before + (arg.dy || 0)));
        return { moved: page._scroll.y - before, mode: page._scroll.y === before && !page._scroll.max ? "внутренний контейнер" : "страница", y: page._scroll.y, max: page._scroll.max };
      }
      if (fn === bt.scrollInnerInPage) {
        const el = arg.self;
        const before = el.scrollTop || 0;
        const box = el.__scroller || el;
        box.scrollTop = Math.max(0, before + (arg.dy || 0));
        return { moved: (box.scrollTop || 0) - before, mode: "контейнер", y: box.scrollTop || 0, max: (box.scrollHeight || 0) - (box.clientHeight || 0) };
      }
      if (fn === bt.idleStartInPage) return true;
      if (fn === bt.idleTakeInPage) return page._takes.length ? page._takes.shift() : 0;
      if (fn === bt.idleStopInPage) return true;
      // карта страницы (collectInPage)
      return {
        url: page._u,
        title: "Страница",
        items: page.els.map((e, i) => ({
          ref: e.ref || "e" + (i + 1),
          tag: e.tag,
          roleAttr: e.role,
          text: e.text || e.name,
          inViewport: e.inViewport !== false,
          disabled: !!e.disabled,
        })),
      };
    };
    return page;
  }

  const els = [
    mkEl({ key: "login", role: "button", name: "Войти" }),
    mkEl({ key: "settings", role: "button", name: "Настройки", inViewport: false }),
    mkEl({ key: "list", role: "button", name: "Список API" }),
    mkEl({ key: "menu", role: "button", name: "Профиль", onHover: () => { els.push(mkEl({ key: "logout", role: "menuitem", name: "Выйти" })); } }),
  ];
  els.forEach((e, i) => { e.ref = "e" + (i + 1); });
  const page = fakePage(els);
  const mockBrowser = {
    isConnected: () => true,
    on() {},
    async pages() { return [page]; },
    async newPage() { return page; },
    async close() {},
  };

  await bt.close({ tabId: "all" });
  bt.setPlaywright({
    chromium: {
      executablePath: () => "",
      async launch() { return mockBrowser; },
      async launchPersistentContext() { return mockBrowser; },
    },
  });
  try {
    await bt.open({ url: "https://site.test/" });

    await test("browserScroll: крутит колесом и отдаёт то, что попало в кадр", async () => {
      page.wheels.length = 0;
      const r = await bt.scroll({ how: "down" });
      assert.ok(/^OK/.test(r), r);
      assert.deepStrictEqual(page.wheels[0], [0, 640], "колесо не сработало (ожидали 0.8 экрана = 640): " + JSON.stringify(page.wheels));
      assert.ok(/Прокрутка: 640 из 2000 \(32%\)/.test(r), "нет позиции прокрутки:\n" + r);
      // В ответе — что СЕЙЧАС в кадре, с ref: кликать можно сразу, без карты.
      assert.ok(/«Войти»/.test(r), "в кадре нет видимого элемента:\n" + r);
      assert.ok(/browserClick \{ ref: "e1" \}/.test(r), "нет подсказки с ref:\n" + r);
      assert.ok(!/«Настройки»/.test(r), "в кадр попал элемент вне экрана:\n" + r);
    });

    await test("browserScroll: прокрутить ДО элемента (его не было в кадре)", async () => {
      const r = await bt.scroll({ to: "Настройки" });
      assert.ok(/прокрутил до «/.test(r) && /Настройки/.test(r), "не прокрутил до элемента:\n" + r);
      assert.ok(els[1].scrolledIn === true, "scrollIntoView не вызван");
      assert.ok(/Прокрутка:/.test(r), "нет позиции после прокрутки:\n" + r);
      // Промах — честное сообщение с похожими элементами, а не молчание.
      const bad = await bt.scroll({ to: "Корзина" });
      assert.ok(/Не нашёл|Ошибка/.test(bad), "не нашёл элемент, но не сказал:\n" + bad);
    });

    await test("browserScroll: внутренний контейнер крутится там, где стоит курсор", async () => {
      page.wheels.length = 0;
      page.moves.length = 0;
      const r = await bt.scroll({ container: "Список API", how: "down", by: 300 });
      assert.ok(/прокрутил контейнер/.test(r) && /Список API/.test(r), r);
      assert.deepStrictEqual(page.moves[0], [60, 45], "курсор не наведён на контейнер (центр 10+100/2, 20+50/2): " + JSON.stringify(page.moves));
      assert.deepStrictEqual(page.wheels[0], [0, 300], "контейнер не прокручен колесом: " + JSON.stringify(page.wheels));
    });

    await test("browserScroll: страница не сдвинулась — говорит, что крутить контейнер", async () => {
      const still = fakePage([mkEl({ key: "a", role: "button", name: "Кнопка" })], "https://spa.test/");
      still._scroll = { y: 0, max: 0, vh: 800 };
      const browser = {
        isConnected: () => true,
        on() {},
        async pages() { return [still]; },
        async newPage() { return still; },
        async close() {},
      };
      bt.setPlaywright({ chromium: { executablePath: () => "", async launch() { return browser; }, async launchPersistentContext() { return browser; } } });
      await bt.close({ tabId: "all" });
      await bt.open({ url: "https://spa.test/" });
      const r = await bt.scroll({ how: "down" });
      assert.ok(/не сдвинулась/.test(r), "SPA-страница со своим скроллом не распознана:\n" + r);
      assert.ok(/container/.test(r), "нет подсказки про container:\n" + r);
      // Возвращаем рабочий браузер для остальных проверок.
      bt.setPlaywright({ chromium: { executablePath: () => "", async launch() { return mockBrowser; }, async launchPersistentContext() { return mockBrowser; } } });
      await bt.close({ tabId: "all" });
      await bt.open({ url: "https://site.test/" });
    });

    await test("browserHover: наводит мышь и показывает, что раскрылось", async () => {
      const r = await bt.hover({ name: "Профиль" });
      assert.ok(/^OK/.test(r), r);
      assert.ok(els[3].hovered === true, "hover не вызван");
      assert.ok(/Появилось/.test(r), "не сказал, что появилось:\n" + r);
      assert.ok(/«Выйти»/.test(r), "новый пункт меню не назван:\n" + r);
      // Элемент без hover-меню — честный ответ с подсказкой.
      const quiet = await bt.hover({ name: "Войти" });
      assert.ok(/Новых элементов не появилось/.test(quiet), quiet);
      assert.ok(/browserClick/.test(quiet), "нет совета, что делать дальше:\n" + quiet);
    });

    await test("browserNetwork: что ушло на сервер и что он ответил", async () => {
      const req = { method: () => "POST", url: () => "https://site.test/api/login", resourceType: () => "xhr" };
      const res = {
        request: () => req,
        status: () => 401,
        headers: () => ({ "content-type": "application/json; charset=utf-8" }),
        text: async () => '{"error":"invalid password"}',
      };
      page.emit("request", req);
      page.emit("response", res);
      await new Promise((r) => setTimeout(r, 5));
      const out = await bt.network({});
      assert.ok(/POST https:\/\/site.test\/api\/login → 401/.test(out), "нет строки запроса:\n" + out);
      assert.ok(/❌/.test(out), "ошибка ответа не помечена:\n" + out);
      assert.ok(/invalid password/.test(out), "тело ответа не показано:\n" + out);
      assert.ok(/4xx\/5xx/.test(out), "нет совета, что делать с ошибкой:\n" + out);
      // По умолчанию журнал очищается: второй вызов не повторяет старое.
      const again = await bt.network({});
      assert.ok(/новых запросов нет/.test(again), again);
      // Статика не мешает, если её не просили.
      const img = { method: () => "GET", url: () => "https://site.test/logo.png", resourceType: () => "image" };
      page.emit("request", img);
      page.emit("response", { request: () => img, status: () => 200, headers: () => ({ "content-type": "image/png" }), text: async () => "" });
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(/новых запросов нет/.test(await bt.network({})), "картинка попала в отчёт без all: true");
      page.emit("request", img);
      page.emit("response", { request: () => img, status: () => 200, headers: () => ({ "content-type": "image/png" }), text: async () => "" });
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(/logo\.png/.test(await bt.network({ all: true })), "с all: true статика не показана");
      // Фильтр по адресу.
      const api = { method: () => "GET", url: () => "https://site.test/api/items", resourceType: () => "xhr" };
      page.emit("request", api);
      page.emit("response", { request: () => api, status: () => 200, headers: () => ({ "content-type": "application/json" }), text: async () => "[]" });
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(/api\/items/.test(await bt.network({ filter: "api/items" })), "фильтр не применён");
    });

    await test("waitForIdle: ждёт тишину DOM и сеть без запросов", async () => {
      page._takes = [3, 1, 0];
      const started = Date.now();
      const r = await bt.waitForIdle({ quietMs: 100, timeout: 3000 });
      assert.ok(/успокоилась/.test(r), r);
      assert.ok(/изменений DOM 4/.test(r), "мутации не посчитаны:\n" + r);
      assert.ok(Date.now() - started >= 90, "вернулся раньше тишины");
      assert.ok(/browserSnapshot/.test(r), "нет совета, что делать после покоя:\n" + r);
    });

    await test("страница-помощники: контейнер со скроллом находится и крутится", () => {
      // Мини-DOM: тело не скроллится, а внутренний блок — да (типичная SPA).
      const mkNode = (o) => Object.assign({
        scrollTop: 0, scrollLeft: 0, scrollHeight: 0, clientHeight: 0,
        className: "", parentElement: null, innerHeight: 0,
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
      }, o);
      const inner = mkNode({ scrollHeight: 1000, clientHeight: 300, className: "list" });
      const child = mkNode({ parentElement: inner });
      const body = mkNode({ scrollHeight: 300, clientHeight: 300 });
      const docEl = mkNode({ scrollHeight: 300, clientHeight: 300, parentElement: body });
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevStyle = global.getComputedStyle;
      global.document = { body, documentElement: docEl, querySelectorAll: () => [inner] };
      global.window = { innerHeight: 300, scrollY: 0, scrollX: 0, scrollBy() {}, scrollTo() {} };
      global.getComputedStyle = (el) => ({ overflowY: el === inner ? "auto" : "visible", visibility: "visible", display: "block", opacity: "1" });
      try {
        const state = bt.scrollStateInPage();
        assert.strictEqual(state.vh, 300);
        assert.strictEqual(state.inner.length, 1, "внутренний контейнер со скроллом не найден: " + JSON.stringify(state));
        // Крутим от ребёнка — поднимаемся до прокручиваемого родителя.
        const res = bt.scrollInnerInPage({ self: child, dy: 200 });
        assert.strictEqual(inner.scrollTop, 200, "прокрутка не дошла до контейнера: " + inner.scrollTop);
        assert.strictEqual(res.moved, 200);
        assert.strictEqual(res.max, 700);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.getComputedStyle = prevStyle;
      }
    });

    await test("browserScroll/browserHover/browserNetwork/waitForIdle связаны с приложением", () => {
      for (const t of ["browserScroll", "browserHover", "browserNetwork", "waitForIdle", "agentGuide"]) {
        assert.ok(new RegExp('case "' + t + '"').test(mainSrc), "main.js не обрабатывает " + t);
        const def = AgentCore.TOOL_DEFINITIONS.find((x) => x.function && x.function.name === t);
        assert.ok(def, "нет определения инструмента " + t);
        assert.ok(AgentCore.SYSTEM_PROMPT.indexOf(t) !== -1, t + " нет в списке инструментов промпта");
      }
      // Прокрутка умеет внутренние контейнеры и «до элемента» — это и просил пользователь.
      const scrollDef = AgentCore.TOOL_DEFINITIONS.find((x) => x.function.name === "browserScroll").function;
      for (const p of ["how", "by", "times", "to", "container"]) {
        assert.ok(scrollDef.parameters.properties[p], "у browserScroll нет параметра " + p);
      }
      assert.ok(/container/.test(scrollDef.description) && /внутренний/i.test(scrollDef.description), "описание не объясняет внутренние контейнеры");
      // Сеть спрашивают ПОСЛЕ действия — это должно быть в описании.
      assert.ok(/browserNetwork/.test(coreSrc) && /что ответил сервер/i.test(coreSrc), "промпт не учит спрашивать сеть после действия");
      // Алиасы, чтобы слабая модель не промахивалась мимо имени.
      for (const a of ["browser_scroll", "hover", "browser_network", "wait_for_idle", "guide"]) {
        assert.ok(/browserScroll|browserHover|browserNetwork|waitForIdle|agentGuide/.test(AgentCore.normalizeToolName(a)), "алиас " + a + " не ведёт к инструменту");
      }
      // При тесном контексте браузерный минимум должен остаться.
      const core = AgentCore.selectTools(8000).map((t) => t.function.name);
      for (const t of ["browserOpen", "browserSnapshot", "browserScroll", "browserHover", "browserNetwork", "waitForIdle", "agentGuide"]) {
        assert.ok(core.indexOf(t) >= 0, t + " выпал из ядра инструментов");
      }
      // Интерфейс: иконки и понятные подписи.
      assert.ok(/browserScroll: "↕️"/.test(appSrc) && /browserNetwork: "📡"/.test(appSrc) && /agentGuide: "📘"/.test(appSrc), "нет иконок новых инструментов");
      assert.ok(/browserScroll: "Прокрутка страницы"/.test(appSrc) && /waitForIdle: "Ожидание покоя страницы"/.test(appSrc), "нет подписей новых инструментов");
      // Веб-версия: справочники и браузер честно недоступны, ожидание покоя = пауза.
      assert.ok(/agentGuide\) доступны в desktop-приложении/.test(appSrc), "веб-версия не отвечает про agentGuide");
    });

    await test("зрение на скриншоте: включается по модели с ключом и спрашивает про кликабельное", () => {
      const shot = mainSrc.slice(mainSrc.indexOf('case "browserScreenshot"'), mainSrc.indexOf('case "browserEval"'));
      assert.ok(/vcfg.visionModel && vcfg.key/.test(shot), "зрение не подключается без галочки «Зрение»");
      assert.ok(/КЛИКАБЕЛЬНЫ/.test(shot), "вопрос зрению не про кликабельные элементы");
      assert.ok(/ЗА пределами экрана/.test(shot), "зрение не спрашивают про то, что за экраном");
      assert.ok(/analyze === false/.test(shot), "нет способа отключить разбор скриншота");
      assert.ok(/Настройки → вкладка «Зрение»/.test(shot), "нет подсказки, как включить зрение");
    });

    await test("справочники по сайтам: гайды есть, домены в шапке, маршрут сохраняется", () => {
      const dir = path.join(ROOT, "src", "agent-guides");
      const files = fs.readdirSync(dir);
      for (const name of ["vk.md", "chat-analysis.md", "google-cloud.md", "github.md"]) {
        assert.ok(files.indexOf(name) >= 0, "нет справочника " + name);
      }
      const gc = fs.readFileSync(path.join(dir, "google-cloud.md"), "utf8");
      assert.ok(/<!--\s*sites:\s*console\.cloud\.google\.com/.test(gc), "в гайде нет домена для авто-подхвата");
      assert.ok(/ENABLE/.test(gc) && /apis\/credentials/.test(gc), "гайд google-cloud не описывает включение API и ключи");
      assert.ok(/Terms of Service|Agree and continue/.test(gc), "гайд не описывает «стену» согласия");
      const gh = fs.readFileSync(path.join(dir, "github.md"), "utf8");
      assert.ok(/sites:\s*github\.com/.test(gh) && /tokens\/new/.test(gh), "гайд github не про токены/домены");
      // Инструмент: список/чтение/подхват по домену/сохранение маршрута.
      assert.ok(/function guideIndex\(\)/.test(mainSrc) && /function guideForUrl\(/.test(mainSrc) && /function agentGuideCall\(/.test(mainSrc), "нет логики справочников в main.js");
      assert.ok(/guideForUrl\(args && args.url\)/.test(mainSrc), "browserOpen не подсказывает справочник");
      assert.ok(/agent-guides/.test(mainSrc) && /userData/.test(mainSrc), "выученные справочники не сохраняются в память приложения");
      assert.ok(/^34\. Справочники и память маршрутов:/m.test(AgentCore.SYSTEM_PROMPT), "в промпте нет правила про справочники и маршруты");
      assert.ok(/^33\. Интерфейсы сайтов собраны из одних и тех же узоров/m.test(AgentCore.SYSTEM_PROMPT), "в промпте нет книги UI-паттернов");
    });

    await test("книга UI-паттернов: Material-select, автокомплит, длинные списки", () => {
      const p = modelPrompt(); // промпт + автоподключаемый справочник группы browser (промпт-диета)
      assert.ok(/НЕ <select>/.test(p), "не сказано, что Material-select — не <select>");
      assert.ok(/Автокомплит|подсказк/i.test(p), "нет правила про автокомплит (ввёл → выбрал подсказку)");
      assert.ok(/НЕ скролль вручную/.test(p), "нет правила про длинные списки (искать, а не скроллить)");
      assert.ok(/opacity: 0|скрытый ввод/.test(p), "нет правила про прозрачные чекбоксы");
      assert.ok(/Date-?\s?пикер|Дата-пикеры/i.test(p), "нет правила про дата-пикеры и деревья");
    });
  } finally {
    bt.setPlaywright(null);
  }
}

// ── Живая сессия PowerShell: один процесс на все системные справки ──────────
async function testPowerShellSession() {
  const ps = require(path.join(ROOT, "src", "win-ps.js"));
  const markers = ps.__markers();
  const { EventEmitter } = require("events");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");

  // Фальшивый powershell.exe: считает, сколько раз его запускали, и отвечает
  // так же, как настоящая обёртка (маркеры BEGIN/END + код).
  function harness() {
    const state = { spawns: 0, last: null, reply: () => {}, onWrite: () => {} };
    ps.__setPlatformForTests(() => "win32");
    ps.__setSpawnForTests((file, args) => {
      state.spawns++;
      state.lastArgs = args;
      const c = new EventEmitter();
      c.stdin = {
        writable: true,
        write(s) {
          state.onWrite(String(s));
        },
      };
      c.stdout = new EventEmitter();
      c.stdout.setEncoding = () => {};
      c.stderr = new EventEmitter();
      c.kill = () => {
        c.killed = true;
      };
      state.last = c;
      return c;
    });
    state.reply = (out, code) =>
      state.last.stdout.emit("data", markers.BEGIN + "\n" + out + "\n" + markers.END + code + "\n");
    return state;
  }

  await test("живая PowerShell: рукопожатие один раз, дальше все скрипты в одном процессе", async () => {
    const h = harness();
    const real = [];
    let handshakes = 0;
    h.onWrite = (line) => {
      const script = Buffer.from(line.trim(), "base64").toString("utf8");
      if (script.indexOf(markers.HANDSHAKE) !== -1) {
        handshakes++;
        setTimeout(() => h.reply(markers.HANDSHAKE, 0), 1);
        return;
      }
      real.push(script);
      setTimeout(() => h.reply("вывод " + real.length, 0), 1);
    };
    try {
      const a = await ps.exec("Get-Date");
      const b = await ps.exec("Get-Item 'C:\\temp'");
      assert.strictEqual(a.ok, true, "первый скрипт не выполнился: " + JSON.stringify(a));
      assert.strictEqual(a.out, "вывод 1", "вывод разобран неверно: " + JSON.stringify(a.out));
      assert.strictEqual(b.out, "вывод 2", "второй скрипт не прошёл через ту же сессию");
      assert.deepStrictEqual(real, ["Get-Date", "Get-Item 'C:\\temp'"], "скрипты потерялись при base64-передаче");
      assert.strictEqual(handshakes, 1, "рукопожатие делается не один раз");
      assert.strictEqual(h.spawns, 1, "процесс PowerShell поднят больше одного раза");
      assert.strictEqual(ps.isRunning(), true, "сессия не держится между вызовами");
      const args = h.lastArgs || [];
      assert.ok(args.indexOf("-EncodedCommand") !== -1, "обёртка не уходит через -EncodedCommand");
      assert.strictEqual(args[0], "-NoProfile", "сессия грузит профиль (это те самые секунды)");
      const decoded = Buffer.from(args[args.length - 1], "base64").toString("utf16le");
      assert.ok(/while \(\$true\)/.test(decoded), "обёртка не читает команды в цикле");
      assert.ok(decoded.indexOf(markers.EXIT) !== -1, "обёртка не понимает команду выхода");
      assert.ok(decoded.indexOf("FromBase64String") !== -1, "обёртка не декодирует скрипт из base64");

      // Таймаут: сессия умирает, вызывающий получает noSession — и откатывается.
      h.onWrite = () => {};
      const t = await ps.exec("Start-Sleep 100", { timeoutMs: 1000 });
      assert.strictEqual(t.noSession, true, "таймаут не помечен как noSession (откат не сработает)");
      assert.strictEqual(h.last.killed, true, "зависшая сессия не убита");
      assert.strictEqual(ps.isRunning(), false, "умершая сессия осталась в состоянии «жива»");

      // Следующий вызов поднимает новую сессию, а не молча ломается.
      h.onWrite = (line) => {
        const script = Buffer.from(line.trim(), "base64").toString("utf8");
        setTimeout(() => h.reply(script.indexOf(markers.HANDSHAKE) !== -1 ? markers.HANDSHAKE : "ok", 0), 1);
      };
      const c2 = await ps.exec("'ещё'");
      assert.strictEqual(c2.ok, true, "сессия не перезапустилась после сбоя");
      assert.strictEqual(h.spawns, 2, "новая сессия не поднята");
    } finally {
      ps.shutdown();
      ps.__setSpawnForTests(null);
      ps.__setPlatformForTests(null);
    }
  });

  await test("живая PowerShell: провал рукопожатия → мгновенный откат, без зависаний", async () => {
    const h = harness();
    h.onWrite = () => setTimeout(() => h.reply("мусор вместо ответа", 0), 1);
    try {
      const a = await ps.exec("Get-Date");
      assert.strictEqual(a.noSession, true, "неудавшееся рукопожатие не включило откат");
      assert.ok(/не подтвердилась/.test(a.err || ""), "нет понятной причины отказа: " + a.err);
      assert.strictEqual(h.last.killed, true, "нерабочая сессия не убита");
      // Вторая попытка не должна снова поднимать процесс (это были бы секунды впустую).
      const b = await ps.exec("Get-Date");
      assert.strictEqual(b.noSession, true, "вторая попытка не откатилась");
      assert.strictEqual(h.spawns, 1, "после провала рукопожатия процесс поднимается заново");
    } finally {
      ps.shutdown();
      ps.__setSpawnForTests(null);
      ps.__setPlatformForTests(null);
    }
  });

  await test("живая PowerShell: подключена к справкам, кэш и откат на месте", () => {
    assert.ok(/async function psScript\(script, timeoutMs\)/.test(mainSrc), "нет psScript в main.js");
    assert.ok(/await winPs\.exec\(script, \{ timeoutMs: ms \}\)/.test(mainSrc), "psScript не использует живую сессию");
    assert.ok(
      /return spawnRaw\(\["powershell\.exe", "-NoProfile", "-NonInteractive", "-Command", script\]/.test(mainSrc),
      "нет отката на разовый запуск PowerShell"
    );
    assert.ok(
      !/spawnRaw\(\["powershell\.exe", "-NoProfile", "-NonInteractive", "-Command", ps\], \{ cwd: os\.homedir\(\), timeoutMs: 30000 \}\)/.test(mainSrc),
      "getSystemInfo по-прежнему поднимает процесс на каждый вопрос"
    );
    assert.ok(/cachedPs\("sysinfo", 30000/.test(mainSrc), "нет кэша конфигурации ПК");
    assert.ok(/cachedPs\("proc:win", 2000/.test(mainSrc), "нет кэша списка процессов");
    assert.ok(/cachedPs\(\s*"reg:"/.test(mainSrc), "нет кэша чтения реестра");
    assert.ok(/invalidatePsCache\("proc:"\)/.test(mainSrc), "killProcess не сбрасывает кэш процессов");
    assert.ok(/invalidatePsCache\("reg:"\)/.test(mainSrc), "registryWrite не сбрасывает кэш реестра");
    assert.ok(
      /\(v\) => \/__ERR__\|Cannot find\|не найден\|отказано\/i\.test\(v\.out\)/.test(mainSrc),
      "ошибка чтения реестра попадёт в кэш"
    );
  });
}

// ── Кэш промпта: статичный префикс и метрики токенов ─────────────────────────
async function testPromptCacheAndUsage() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");
  const orSettings = { provider: "openai", openaiUrl: "https://openrouter.ai/api/v1", openaiApiKey: "k" };

  await test("кэш промпта: кэшируемый блок — только статичный SYSTEM_PROMPT", () => {
    const prompt = core.SYSTEM_PROMPT;
    const dynamic = "\n\nРабочая директория: /home/user\n=== САММАРИ ПРОЕКТА ===\n📁 src/";
    const sp = core.splitStaticSystem(prompt + dynamic, prompt);
    assert.ok(sp, "статичный префикс не распознан");
    assert.strictEqual(sp.head, prompt, "в кэшируемый блок попал не весь статичный промпт");
    assert.strictEqual(sp.tail, dynamic, "динамический хвост отделён неверно");
    assert.ok(
      sp.head.indexOf("/home/user") === -1 && sp.head.indexOf("📁") === -1,
      "динамический «паспорт проекта» попал в кэшируемый блок"
    );
    assert.strictEqual(core.splitStaticSystem("совсем другой текст", prompt), null, "чужой текст признан статичным");
    assert.strictEqual(core.splitStaticSystem(prompt, ""), null, "пустая граница принята за статичный префикс");
  });

  await test("кэш промпта: OpenRouter+Claude — кэш только на статичном блоке", () => {
    const prompt = core.SYSTEM_PROMPT;
    const dynamic = "\n\n=== САММАРИ ПРОЕКТА ===\n📄 package.json";
    const req = core.buildChatRequest(orSettings, {
      model: "anthropic/claude-3.5-sonnet",
      messages: [{ role: "system", content: prompt + dynamic }, { role: "user", content: "привет" }],
      tools: core.TOOL_DEFINITIONS,
      staticSystem: prompt,
    });
    const sys = JSON.parse(req.body).messages[0];
    assert.strictEqual(sys.role, "system");
    assert.ok(Array.isArray(sys.content), "system не разбит на блоки");
    assert.strictEqual(sys.content.length, 2, "ожидались два блока: статичный и динамический");
    assert.ok(sys.content[0].cache_control, "нет точки кэша на статичном блоке");
    assert.ok(!sys.content[1].cache_control, "точка кэша попала на динамический блок");
    assert.strictEqual(sys.content[0].text, prompt, "статичный блок искажён");
    assert.strictEqual(sys.content[1].text, dynamic, "динамический блок искажён");
    assert.ok(sys.content[0].text.indexOf("📄 package.json") === -1, "динамика осталась в кэшируемом блоке");
    // Без границы — прежнее поведение: один кэшируемый блок целиком.
    const plain = JSON.parse(
      core.buildChatRequest(orSettings, {
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "system", content: prompt + dynamic }],
        tools: [],
      }).body
    ).messages[0];
    assert.strictEqual(plain.content.length, 1, "без границы блок должен остаться один");
  });

  await test("кэш промпта: Anthropic — system блоками, схемы инструментов тоже кэшируются", () => {
    const prompt = core.SYSTEM_PROMPT;
    const ant = { provider: "anthropic", anthropicUrl: "https://api.anthropic.com", anthropicApiKey: "k" };
    const body = JSON.parse(
      core.buildChatRequest(ant, {
        model: "claude-sonnet-4",
        messages: [{ role: "system", content: prompt + "\n\nПлан: пункт 1" }, { role: "user", content: "ок" }],
        tools: core.TOOL_DEFINITIONS,
        staticSystem: prompt,
      }).body
    );
    assert.ok(Array.isArray(body.system), "system не блоками");
    assert.strictEqual(body.system.length, 2, "динамика должна идти отдельным блоком");
    assert.ok(body.system[0].cache_control, "нет точки кэша на статичном промпте");
    assert.ok(!body.system[1].cache_control, "точка кэша накрыла динамику");
    assert.ok(body.tools[body.tools.length - 1].cache_control, "схемы инструментов не кэшируются");
    // Без границы — как раньше: один блок под кэш.
    const old = JSON.parse(
      core.buildChatRequest(ant, {
        model: "claude-sonnet-4",
        messages: [{ role: "system", content: prompt }],
        tools: [],
      }).body
    );
    assert.strictEqual(old.system.length, 1, "без границы ожидается один блок");
    assert.ok(old.system[0].cache_control, "точка кэша пропала вовсе");
  });
  await test("кэш промпта: Anthropic + справочники — кэш только на статике, ничего не теряется", () => {
    const prompt = core.SYSTEM_PROMPT;
    const brief = "\n\nРабочая директория: /home/user\n=== САММАРИ ПРОЕКТА ===\n📁 src/";
    const guideA = '=== СПРАВОЧНИК АГЕНТА: "browser" (группа "browser") ===\nБыстрый путь: browserOpen → browserSnapshot';
    const guideB = '=== СПРАВОЧНИК АГЕНТА: "yc" (группа "cloud") ===\nНачни с ycStatus';
    // Ровно та раскладка, что строит main.js: [system(промпт+brief), ...guideNotes, ...история]
    const messages = [
      { role: "system", content: prompt + brief },
      { role: "system", content: guideA },
      { role: "system", content: guideB },
      { role: "user", content: "открой сайт" },
      { role: "assistant", content: "ок" },
    ];
    const ant = { provider: "anthropic", anthropicUrl: "https://api.anthropic.com", anthropicApiKey: "k" };
    const body = JSON.parse(
      core.buildChatRequest(ant, { model: "claude-sonnet-4", messages, tools: [], staticSystem: prompt }).body
    );
    assert.ok(Array.isArray(body.system), "system не блоками");
    assert.strictEqual(body.system.length, 2, "ожидались статичный блок + динамика со справочниками");
    assert.ok(body.system[0].cache_control, "нет точки кэша на статичном промпте");
    assert.ok(!body.system[1].cache_control, "точка кэша накрыла динамику и справочники");
    assert.strictEqual(body.system[0].text, prompt, "статичный блок искажён");
    const tail = body.system[1].text;
    assert.ok(tail.indexOf(guideA) !== -1 && tail.indexOf(guideB) !== -1, "справочники потерялись в system");
    assert.ok(tail.indexOf("/home/user") !== -1, "паспорт проекта потерялся");
    assert.ok(body.system[0].text.indexOf("СПРАВОЧНИК АГЕНТА") === -1, "справочник попал в кэшируемый блок");
    assert.ok(!body.messages.some((m) => m.role === "system"), "system остался в messages");
    assert.deepStrictEqual(body.messages.map((m) => m.role), ["user", "assistant"], "история диалога повреждена");
    // Заметка о повторной попытке приходит ПОСЛЕ истории (main.js) — у Anthropic она тоже
    // обязана уехать в верхнеуровневый system: system внутри messages API не принимает.
    const retryBody = JSON.parse(
      core.buildChatRequest(ant, {
        model: "claude-sonnet-4",
        messages: [
          { role: "system", content: prompt + brief },
          { role: "user", content: "почини баг" },
          { role: "assistant", content: "работаю" },
          { role: "system", content: "⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА — авто-повтор" },
          { role: "user", content: "продолжай" },
        ],
        tools: [],
        staticSystem: prompt,
      }).body
    );
    assert.ok(!retryBody.messages.some((m) => m.role === "system"), "заметка о повторе осталась в messages");
    assert.strictEqual(retryBody.system.length, 2, "заметка раздвоила блоки system");
    assert.ok(
      retryBody.system[1].text.indexOf("ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА") !== -1,
      "заметка о повторе не попала в system"
    );
    assert.ok(!retryBody.system[1].cache_control, "кэш накрыл заметку о повторе");
  });

  await test("G4F: строгий OpenAI-совместимый получает ОДИН ведущий system и никаких полей кэша", () => {
    const prompt = core.SYSTEM_PROMPT;
    const g4f = { provider: "openai", openaiUrl: "http://localhost:1337/v1", openaiApiKey: "" };
    const guideA = '=== СПРАВОЧНИК АГЕНТА: "browser" (группа "browser") ===\nБыстрый путь';
    const guideB = '=== СПРАВОЧНИК АГЕНТА: "system" (группа "system") ===\nОболочки: shellsStatus';
    const messages = [
      { role: "system", content: prompt + "\n\nРабочая директория: /home/user" },
      { role: "system", content: guideA },
      { role: "system", content: guideB },
      { role: "user", content: "привет" },
    ];
    const req = core.buildChatRequest(g4f, { model: "HuggingChat:gpt-4o-mini", messages, tools: [], staticSystem: prompt });
    const body = JSON.parse(req.body);
    assert.ok(/\/chat\/completions$/.test(req.url), "не OpenAI-совместимый путь: " + req.url);
    // Маршрут «Провайдер:модель»: современный g4f ждёт провайдера отдельным полем.
    assert.strictEqual(body.provider, "HuggingChat", "провайдер G4F не ушёл отдельным полем");
    assert.strictEqual(body.model, "gpt-4o-mini", "имя модели не очищено от префикса провайдера");
    const sysMsgs = body.messages.filter((m) => m.role === "system");
    assert.strictEqual(sysMsgs.length, 1, "у строгого сервера больше одного system: " + sysMsgs.length);
    assert.strictEqual(body.messages[0].role, "system", "system не в начале диалога");
    const head = sysMsgs[0].content;
    assert.ok(head.startsWith(prompt), "статичный промпт потерялся или сдвинулся");
    assert.ok(head.indexOf("Рабочая директория: /home/user") !== -1, "паспорт проекта потерялся");
    assert.ok(head.indexOf(guideA) !== -1 && head.indexOf(guideB) !== -1, "справочники потерялись");
    assert.ok(
      head.indexOf("Быстрый путь\n\n=== СПРАВОЧНИК АГЕНТА: \"system\"") !== -1,
      "ведущие system склеены не через пустую строку (порядок/разделитель изменились)"
    );
    assert.ok(!/cache_control/.test(req.body), "поле кэша ушло строгому OpenAI-совместимому");
    assert.strictEqual(body.stream_options, undefined, "stream_options ушёл без запроса");
    // Исходный массив не мутируем, а служебная заметка в середине остаётся на месте.
    assert.strictEqual(messages.filter((m) => m.role === "system").length, 3, "исходные сообщения изменены");
    const retry = JSON.parse(
      core.buildChatRequest(g4f, {
        model: "gpt-4o-mini",
        messages: messages.concat([
          { role: "assistant", content: "ок" },
          { role: "system", content: "⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА" },
          { role: "user", content: "продолжай" },
        ]),
        tools: [],
      }).body
    );
    assert.strictEqual(retry.messages.filter((m) => m.role === "system").length, 2, "склеились и служебные заметки — они должны остаться на месте");
    assert.strictEqual(retry.messages[retry.messages.length - 2].content, "⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА", "заметка о повторе сдвинулась");
  });

  await test("кэш промпта: OpenRouter + справочники — одна точка кэша и ничего не теряется", () => {
    const prompt = core.SYSTEM_PROMPT;
    const guide = '=== СПРАВОЧНИК АГЕНТА: "app" (группа "app") ===\nappRead → appClick';
    const body = JSON.parse(
      core.buildChatRequest(orSettings, {
        model: "anthropic/claude-3.5-sonnet",
        messages: [
          { role: "system", content: prompt + "\n\n📁 src/" },
          { role: "system", content: guide },
          { role: "user", content: "нажми Сохранить в настройках" },
        ],
        tools: [],
        staticSystem: prompt,
      }).body
    );
    const sys = body.messages[0];
    assert.strictEqual(sys.role, "system", "первым должен идти system");
    assert.ok(Array.isArray(sys.content), "system не разбит на блоки");
    assert.strictEqual(sys.content.length, 2, "ожидались статичный блок и хвост");
    assert.ok(sys.content[0].cache_control, "нет точки кэша на статике");
    assert.ok(!sys.content[1].cache_control, "кэш накрыл динамику");
    assert.strictEqual(sys.content[0].text, prompt, "статичный блок искажён");
    assert.ok(sys.content[1].text.indexOf(guide) !== -1, "справочник потерялся");
    const points = JSON.parse(JSON.stringify(body)).messages
      .filter((m) => m.role === "system")
      .reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.cache_control).length : 0), 0);
    assert.strictEqual(points, 1, "точек кэша должно быть ровно одна, а не " + points);
    assert.strictEqual(body.messages.filter((m) => m.role === "system").length, 1, "справочник ушёл отдельным system-сообщением");
  });

  await test("метрики: stream_options.include_usage только там, где его ждут", () => {
    const msgs = [{ role: "system", content: core.SYSTEM_PROMPT }, { role: "user", content: "привет" }];
    const strict = { provider: "openai", openaiUrl: "https://api.deepseek.com/v1", openaiApiKey: "k" };
    const on = JSON.parse(core.buildChatRequest(strict, { model: "deepseek-chat", messages: msgs, tools: [], includeUsage: true }).body);
    assert.deepStrictEqual(on.stream_options, { include_usage: true }, "нет stream_options.include_usage");
    const off = JSON.parse(core.buildChatRequest(strict, { model: "deepseek-chat", messages: msgs, tools: [] }).body);
    assert.strictEqual(off.stream_options, undefined, "stream_options ушёл без запроса");
    const ant = JSON.parse(
      core.buildChatRequest(
        { provider: "anthropic", anthropicUrl: "https://api.anthropic.com", anthropicApiKey: "k" },
        { model: "claude-sonnet-4", messages: msgs, tools: [], includeUsage: true }
      ).body
    );
    assert.strictEqual(ant.stream_options, undefined, "stream_options ушёл в Anthropic");
    const ol = JSON.parse(
      core.buildChatRequest({ provider: "ollama", ollamaUrl: "http://localhost:11434" }, {
        model: "qwen3:4b",
        messages: msgs,
        tools: [],
        includeUsage: true,
      }).body
    );
    assert.strictEqual(ol.stream_options, undefined, "stream_options ушёл в Ollama");
  });

  await test("метрики: токен-отчёт разных провайдеров приводится к одному виду", () => {
    assert.deepStrictEqual(
      core.normalizeUsage({ prompt_tokens: 29042, completion_tokens: 512, prompt_tokens_details: { cached_tokens: 26880 } }),
      { prompt: 29042, completion: 512, cached: 26880 }
    );
    assert.deepStrictEqual(core.normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900 }), {
      prompt: 1000,
      completion: 50,
      cached: 900,
    });
    assert.deepStrictEqual(core.normalizeUsage({ input_tokens: 800, output_tokens: 120, cache_read_input_tokens: 700 }), {
      prompt: 800,
      completion: 120,
      cached: 700,
    });
    // Без данных кэша — ноль, а не NaN (иначе в консоль уйдёт «кэш NaN%»).
    assert.deepStrictEqual(core.normalizeUsage({ prompt_tokens: 10 }), { prompt: 10, completion: 0, cached: 0 });
    assert.strictEqual(core.normalizeUsage(null), null);
    assert.strictEqual(core.normalizeUsage("мусор"), null);
  });

  await test("метрики: цифры уходят в «Консоль», откат без stream_options на месте", () => {
    assert.ok(/onUsage: \(u\) => \{/.test(mainSrc), "usage ответа не принимается");
    assert.ok(/roundUsage\.cached = Math\.max\(roundUsage\.cached, u\.cached \|\| 0\)/.test(mainSrc), "кэш не собирается по раунду");
    assert.ok(/termEmit\(\{[\s\S]{0,80}?type: "metrics"/.test(mainSrc), "строка метрик не отправляется");
    assert.ok(/staticSystem: SYSTEM_PROMPT/.test(mainSrc), "граница статичного промпта не передана в запрос");
    assert.ok(/includeUsage: includeUsage/.test(mainSrc), "флаг токен-отчёта не передаётся в запрос");
    assert.ok(/roundTtfbMs = Date\.now\(\) - roundStartedAt/.test(mainSrc), "нет замера времени до первого байта");
    // Строгий сервер без stream_options: выключаем и повторяем раунд, а не падаем.
    assert.ok(
      /includeUsage &&\s*\(res\.status === 400 \|\| res\.status === 422\)/.test(mainSrc),
      "нет отката для сервера без stream_options"
    );
    assert.ok(
      /includeUsage && \/stream_options\|include_usage\/i\.test\(errText\)/.test(mainSrc),
      "нет отката, если провайдер отверг stream_options внутри ответа"
    );
    assert.ok(/includeUsage = false;/.test(mainSrc), "флаг не выключается после отказа");
    assert.ok(/round--;\s*continue;/.test(mainSrc), "раунд не повторяется после отказа");
    // Интерфейс
    assert.ok(/ev\.type === "metrics"/.test(appSrc), "app.js не принимает метрики");
    assert.ok(/\.ts-metrics \{/.test(cssSrc), "нет стиля строки метрик");
  });
}

// ── Роутер инструментов: реестр групп и чистая функция выбора ────────────────
async function testToolRouter() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const allNames = core.TOOL_DEFINITIONS.map((t) => t.function && t.function.name);

  await test("роутер: реестр покрывает все схемы ровно один раз", () => {
    const base = core.BASE_TOOL_NAMES;
    assert.strictEqual(base.length, new Set(base).size, "в базе есть дубли");
    const inGroup = new Map();
    for (const g of core.TOOL_GROUPS) {
      assert.ok(g.id && g.title && Array.isArray(g.names) && g.names.length, "битая группа: " + JSON.stringify(g && g.id));
      assert.ok(Array.isArray(g.keywords) && g.keywords.length, "у группы " + g.id + " нет ключевых слов");
      for (const n of g.names) {
        assert.ok(!inGroup.has(n), "инструмент " + n + " в двух группах: " + inGroup.get(n) + " и " + g.id);
        inGroup.set(n, g.id);
      }
    }
    // База и группы не пересекаются — иначе схема пришла бы дважды.
    for (const n of base) assert.ok(!inGroup.has(n), "базовый " + n + " ещё и в группе " + inGroup.get(n));
    const registered = new Set([...base, ...inGroup.keys()]);
    const missing = allNames.filter((n) => !registered.has(n));
    const extra = [...registered].filter((n) => !allNames.includes(n));
    assert.deepStrictEqual(missing, [], "схемы вне реестра: " + missing.join(", "));
    assert.deepStrictEqual(extra, [], "в реестре несуществующие схемы: " + extra.join(", "));
    // Набор приложения про репозитории: git-минимум обязан быть в базе.
    for (const n of ["gitStatus", "gitDiff", "gitLog", "gitCommit", "gitBranch"]) {
      assert.ok(base.includes(n), n + " не в базе — на тесном окне git исчезнет");
    }
  });

  await test("роутер: порядок схем канонический и детерминированный", () => {
    const r1 = core.routeTools({ text: "почини git push и задеплой на сервер" });
    const r2 = core.routeTools({ text: "почини git push и задеплой на сервер" });
    assert.deepStrictEqual(r1.groups, r2.groups, "состав групп не детерминирован");
    const n1 = r1.tools.map((t) => t.function.name);
    const n2 = r2.tools.map((t) => t.function.name);
    assert.deepStrictEqual(n1, n2, "порядок схем не детерминирован");
    // Канонический порядок = порядок объявления (иначе кэш префикса промахивается).
    assert.deepStrictEqual(n1, allNames.filter((n) => n1.includes(n)), "порядок схем не канонический");
    assert.deepStrictEqual(r1.tools.map((t) => t.function.name), r2.tools.map((t) => t.function.name));
    // forceAll — тот же канонический порядок и полный набор.
    const all = core.routeTools({ forceAll: true });
    assert.strictEqual(all.all, true);
    assert.deepStrictEqual(all.tools.map((t) => t.function.name), allNames);
    assert.strictEqual(all.dropped.length, 0, "forceAll что-то срезал");
  });

  await test("роутер: группа включается по смыслу и остаётся липкой", () => {
    const fresh = core.routeTools({ text: "закоммить и запуш изменения на github" });
    assert.ok(fresh.groups.includes("git"), "группа git не включена: " + fresh.groups.join(","));
    assert.ok(fresh.activated.includes("git"), "git нет в activated");
    // Липкость: следующий запрос без слов о git — группа остаётся до конца задачи.
    const sticky = core.routeTools({ text: "посмотри файл", sticky: fresh.groups });
    assert.ok(sticky.groups.includes("git"), "липкая группа потеряна");
    // Без липкости тот же запрос группу не тянет.
    const lonely = core.routeTools({ text: "привет, как дела" });
    assert.ok(!lonely.groups.includes("git"), "git включился без запроса");
    assert.strictEqual(lonely.groups.length, 0, "тихая задача включила группы: " + lonely.groups.join(","));
    assert.strictEqual(lonely.tools.length, core.BASE_TOOL_NAMES.length, "тихая задача получила не только базу");
  });

  await test("роутер: экономия токенов и потолок не режет базу", () => {
    const all = core.routeTools({ forceAll: true });
    const quiet = core.routeTools({ text: "привет, как дела" });
    assert.ok(quiet.tokens < all.tokens * 0.4, "экономия меньше 60%: " + quiet.tokens + " из " + all.tokens);
    assert.ok(core.ROUTER_MAX_TOKENS >= quiet.tokens, "потолок меньше веса базы");
    // Группа, не влезшая в потолок, попадает в dropped (не пропадает молча).
    const tiny = core.routeTools({ text: "закоммить и запуш на github, открой браузер", maxTokens: quiet.tokens });
    assert.ok(tiny.tools.length >= core.BASE_TOOL_NAMES.length, "база урезана");
    assert.ok(tiny.dropped.length > 0, "срезанная группа не отмечена в dropped");
    assert.ok(
      tiny.groups.every((id) => !tiny.dropped.includes(id)),
      "группа попала и в used, и в dropped"
    );
  });

  await test("роутер: groupOfTool знает группу вызова (предохранитель A)", () => {
    assert.strictEqual(core.groupOfTool("gitPush"), "git");
    assert.strictEqual(core.groupOfTool("browserClick"), "browser");
    assert.strictEqual(core.groupOfTool("getSystemInfo"), "system");
    // Базовый инструмент группы не имеет — дотягивать нечего.
    assert.strictEqual(core.groupOfTool("readFile"), "");
    assert.strictEqual(core.groupOfTool("совсемНетТакого"), "");
    assert.strictEqual(core.groupOfTool(""), "");
    // Вызов инструмента вне текущего набора всегда разрешим через его группу.
    const quiet = core.routeTools({ text: "привет" });
    const quietNames = quiet.tools.map((t) => t.function.name);
    for (const n of ["gitPush", "browserClick", "registryWrite"]) {
      assert.ok(!quietNames.includes(n), n + " неожиданно в базе");
      assert.ok(core.groupOfTool(n), "у " + n + " нет группы — предохранитель A не сработает");
      const widened = core.routeTools({ text: "привет", sticky: quiet.groups.concat(core.groupOfTool(n)) });
      assert.ok(
        widened.tools.map((t) => t.function.name).includes(n),
        "после расширения " + n + " всё равно отсутствует"
      );
    }
  });

  await test("роутер: findTools ищет по-русски и не зависит от порядка", () => {
    assert.ok(core.BASE_TOOL_NAMES.includes("findTools"), "findTools нет в базовом наборе");
    assert.ok(allNames.includes("findTools"), "нет схемы findTools");
    const push = core.searchTools("запуш в github").map((t) => t.name);
    assert.ok(push.includes("gitPush"), "по «запуш» не нашёлся gitPush: " + push.join(","));
    const mail = core.searchTools("отправить письмо по smtp").map((t) => t.name);
    assert.ok(mail.includes("mailSend"), "по «письмо smtp» не нашёлся mailSend: " + mail.join(","));
    const shot = core.searchTools("скриншот экрана").map((t) => t.name);
    assert.ok(shot.includes("screenshotDesktop"), "по «скриншот экрана» не нашёлся screenshotDesktop");
    // Детерминизм: одинаковый запрос — одинаковый список (стабильный префикс промпта).
    assert.deepStrictEqual(core.searchTools("запуш в github"), core.searchTools("запуш в github"));
    // Каждый результат знает свою группу — предохранитель B умеет включить её целиком.
    for (const t of core.searchTools("запуш в github")) {
      if (t.name !== "findTools") assert.ok(t.group, t.name + " без группы");
    }
    // Сам findTools в выдачу не попадает (он и так в базе) и мусор не матчится.
    assert.ok(!core.searchTools("запуш в github").some((t) => t.name === "findTools"), "findTools в выдаче");
    assert.deepStrictEqual(core.searchTools("абракадабращщ"), []);
    assert.deepStrictEqual(core.searchTools(""), []);
  });

  await test("роутер: предохранители подключены в main.js и в настройках", () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
    // A: реальный вызов вне набора дотягивает группу и повторяет раунд со схемой.
    assert.ok(/const gid = groupOfTool\(c\.name\);/.test(mainSrc), "нет предохранителя A");
    assert.ok(/stickyGroups\.add\(gid\);\s*\n\s*refreshTools\(\);/.test(mainSrc), "группа вызова не добавляется на ходу");
    // B: findTools исполняется и включает группы текущей задачи.
    assert.ok(/case "findTools": \{/.test(mainSrc), "findTools не исполняется");
    assert.ok(/activeToolRouter\.addGroups\(groups\)/.test(mainSrc), "findTools не включает группы");
    assert.ok(/activeToolRouter = \{/.test(mainSrc), "нет роутера текущего запуска");
    // C: чекбокс «Отправить все инструменты» + полный набор без роутера.
    assert.ok(/const forceAllTools = !!settings\.sendAllTools;/.test(mainSrc), "настройка не читается агентом");
    assert.ok(/if \(o\.forceAll\)/.test(coreSrc), "forceAll не поддерживается роутером");
    assert.ok(/id="s-send-all-tools"/.test(htmlSrc), "нет чекбокса в настройках");
    assert.ok(/settings\.sendAllTools = !!\$\("s-send-all-tools"\)\.checked;/.test(appSrc), "чекбокс не сохраняется");
    assert.ok(/\$\("s-send-all-tools"\)\.checked = !!settings\.sendAllTools;/.test(appSrc), "чекбокс не восстанавливается");
    // Метрика раунда говорит, сколько групп ушло и что срезано.
    assert.ok(/· групп " \+ routeInfo\.groups\.length/.test(mainSrc), "метрика без числа групп");
    assert.ok(/срезано: " \+ routeInfo\.dropped\.join/.test(mainSrc), "метрика молчит о срезанных группах");
  });
}

(async () => {
  console.log("Smoke-тесты: " + path.basename(__filename));
  await testAgentCore();
  await testAppUiTools();
  await testAppUiRefs();
  await testAgentStore();
  await testContextMemory();
  await testUnifiedPatch();
  await testCodeIndex();
  await testSecrets();
  await testOta();
  await testBrowserTools();
  await testBrowserBrain();
  await testBrowserOverlays();
  await testHighlight();
  await testMobileBridge();
  await testChatPersistence();
  await testSessionExtras();
  await testVault();
  await testVaultUi();
  await testMail();
  await testYandexCloud();
  await testYcDiagnosis();
  await testYcFolderPersistence();
  await testShellAndCdp();
  await testServer();
  await testSelfDev();
  await testPlanPanel();
  await testStreamThrottle();
  await testBrowserSpeed();
  await testBrowserSenses();
  await testAgentSpeedups();
  await testPowerShellSession();
  await testPromptCacheAndUsage();
  await testToolRouter();
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();