"use strict";

/* ── Smoke-тесты (plain node, без фреймворков и без сети) ───────────────────
   Запуск: bun run test  (node test/smoke.test.js)
   Покрывают самые хрупкие узлы, чтобы «хирургические» правки не ломали их молча:
   - agent-core: состав инструментов (в т.ч. browser-*), системный промпт,
     нормализация имён, извлечение tool_calls, тримминг контекста;
   - secrets: разделение настроек, roundtrip записи/чтения, миграция legacy;
   - ota: сравнение версий, применение бандла, защита хеша, отказ без файлов;
   - browser-tools: корректное состояние «браузер не запущен»;
   - server.js: защита /api/llm (только Yandex), валидация /api/fetch.
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
    for (const n of ["browserOpen", "browserFill", "browserClick", "browserSelect", "browserPress", "browserText", "browserScreenshot", "browserWait", "browserClose", "browserStatus"]) {
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

// ── Запуск ──────────────────────────────────────────────────────────────────
(async () => {
  console.log("Smoke-тесты: " + path.basename(__filename));
  await testAgentCore();
  await testAppUiTools();
  await testAgentStore();
  await testUnifiedPatch();
  await testCodeIndex();
  await testSecrets();
  await testOta();
  await testBrowserTools();
  await testMobileBridge();
  await testServer();
  await testSelfDev();
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();