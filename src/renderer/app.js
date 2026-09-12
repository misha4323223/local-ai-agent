"use strict";
(function () {
  const AgentCore = window.AgentCore;
  const $ = (id) => document.getElementById(id);
  const api = window.api || null; // null → браузер (веб-превью)
  const isElectron = !!api;

  // provider: "ollama" | "openai" (OpenAI-совместимые) | "anthropic" (Claude)
  const DEFAULTS = {
    provider: "ollama",
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "",
    openaiUrl: "https://api.groq.com/openai/v1",
    openaiApiKey: "",
    openaiModel: "",
    openaiProject: "", // Yandex AI Studio: ID каталога (OpenAI-Project)
    anthropicUrl: "https://api.anthropic.com",
    anthropicApiKey: "",
    anthropicModel: "",
    model: "", // зеркало модели активного провайдера (для main-процесса / отправки)
    workingDir: "",
    previewUrl: "http://localhost:5000",
    agentEnv: {}, // секреты/переменные окружения: подставляются в команды агента, терминал, git, docker
    githubToken: "",
    githubClientId: "",
    githubLogin: "",
    githubAvatarUrl: "",
    projects: [], // до 10 проектов: { id, name, dir, createdAt, lastOpened }
    activeProjectId: "",
    openaiProfiles: [], // сохранённые OpenAI-совместимые подключения: { id, name, url, apiKey, model, project }
    openaiActiveProfile: "", // id активного подключения
    autoSwitchProfiles: false, // при ошибке ключа/баланса/лимита — авто-переключение
    sendAllTools: false, // предохранитель C: слать все схемы инструментов (медленнее, но надёжнее)
  };

  // Пресеты для OpenAI-совместимых API (ключ/модель хранятся отдельно по каждому пресету? нет — единый URL+ключ).
  const PRESETS = {
    deepseek: { url: "https://api.deepseek.com/v1" },
    openai: { url: "https://api.openai.com/v1" },
    groq: { url: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
    cerebras: { url: "https://api.cerebras.ai/v1", model: "qwen-3-235b-a22b-instruct-2507" },
    ollamacloud: { url: "https://ollama.com/v1", model: "gpt-oss:120b" },
    openrouter: { url: "https://openrouter.ai/api/v1" },
    nvidia: { url: "https://integrate.api.nvidia.com/v1" },
    mistral: { url: "https://api.mistral.ai/v1", model: "devstral-2-2512" },
    yandex: { url: "https://ai.api.cloud.yandex.net/v1" },
    g4f: { url: "http://localhost:1337/v1" },
    custom: null,
  };
  const PRESET_LABEL = {
    deepseek: "DeepSeek",
    openai: "OpenAI",
    groq: "Groq",
    cerebras: "Cerebras",
    ollamacloud: "Ollama Cloud",
    openrouter: "OpenRouter",
    nvidia: "NVIDIA NIM",
    mistral: "Mistral Devstral",
    yandex: "Yandex AI Studio",
    g4f: "G4F",
    custom: "Свой",
  };

  // Провайдеры G4F — единый реестр живёт в agent-core.js (его же использует транспорт
  // buildChatRequest для маршрута «Провайдер:модель»).
  const G4F_PROVIDERS = (AgentCore && AgentCore.G4F_PROVIDERS) || [];

  // Ключи настроек по провайдеру (поле URL / API-ключ / модель)
  const MODEL_KEY = { ollama: "ollamaModel", openai: "openaiModel", anthropic: "anthropicModel" };
  const URL_KEY = { ollama: "ollamaUrl", openai: "openaiUrl", anthropic: "anthropicUrl" };
  const KEY_FIELD = { openai: "openaiApiKey", anthropic: "anthropicApiKey" };
  const MODEL_INPUT = { ollama: "s-ollama-model", openai: "s-openai-model", anthropic: "s-anth-model" };
  const URL_INPUT = { ollama: "s-ollama-url", openai: "s-openai-url", anthropic: "s-anth-url" };
  const KEY_INPUT = { openai: "s-openai-key", anthropic: "s-anth-key" };
  const KEY_TOGGLE = { openai: "btn-toggle-key", anthropic: "btn-toggle-anth-key" };
  const REFRESH_INPUT = { ollama: "btn-refresh-ollama-models", openai: "btn-refresh-models", anthropic: "btn-refresh-anth-models" };

  let settings = { ...DEFAULTS };
  let githubReposList = null;
  let chatsData = { chats: [], activeId: null };
  let streaming = false;
  let session = null; // { chatId, assistantId, segmentIds: [] }
  let webAbort = null;
  let planToggleOn = false; // «Режим плана» — сначала план, потом выполнение
  let lastUndoCount = 0; // сколько файлов можно откатить после последнего ответа агента
  let pendingImage = null; // dataURL скриншота, прикреплённого к следующему сообщению
  let cachedModels = {}; // кэш списков моделей по провайдеру (для быстрого переключения в шапке)

  // Вставка изображений (Ctrl+V): если в буфере картинка — прикрепляем к сообщению
  function onInputPaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        e.preventDefault();
        const file = it.getAsFile && it.getAsFile();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          pendingImage = String(reader.result || "");
          $("attach-bar").classList.remove("hidden");
          $("attach-thumb").src = pendingImage;
        };
        reader.readAsDataURL(file);
        return;
      }
    }
  }
  function hideAttachBar() {
    pendingImage = null;
    $("attach-bar").classList.add("hidden");
    $("attach-thumb").removeAttribute("src");
  }
  let currentPreset = "deepseek";
  let g4fProviderQuery = ""; // поиск по провайдерам G4F в настройках
  let g4fProbeLastTs = 0; // авто-подбор порта G4F: не чаще раза в 30 секунд
  const msgEls = new Map();

  // ── Выбор провайдера G4F (аккордеон в настройках): поиск по буквам + список ──
  // Клик по провайдеру подставляет маршрут «Провайдер:модель» в поле модели.
  function renderG4fProviderList() {
    const list = $("g4f-provider-list");
    const status = $("g4f-provider-status");
    if (!list) return;
    const q = g4fProviderQuery.trim().toLowerCase();
    const provs = G4F_PROVIDERS.filter(
      (p) => !q || p.name.toLowerCase().includes(q) || (p.desc || "").toLowerCase().includes(q)
    );
    list.innerHTML = "";
    if (!provs.length) {
      if (status) {
        status.textContent = "Поиск «" + g4fProviderQuery + "»: ничего не найдено. Попробуй другие буквы (например: deep, chat, open, qwen).";
        status.className = "gh-repos-status err";
      }
      return;
    }
    if (status) {
      status.textContent = g4fProviderQuery.trim()
        ? "Поиск «" + g4fProviderQuery + "»: найдено " + provs.length + " — нажми на провайдера, его модели появятся ниже."
        : "Провайдеров G4F: " + provs.length + " (★ — стабильные, без ключа). Нажми — подставится «Провайдер:модель», модели покажутся ниже.";
      status.className = "gh-repos-status";
    }
    const curModel = ($("s-openai-model").value || "").trim();
    for (const p of provs) {
      const isSelected = curModel.toLowerCase().startsWith(p.name.toLowerCase() + ":");
      const item = document.createElement("div");
      item.className = "gh-repo-item" + (isSelected ? " selected" : "");
      item.innerHTML =
        '<span class="repo-icon">' + (p.rec ? "★" : "◆") + "</span>" +
        '<span class="repo-info">' +
        '<span class="repo-slug">' + escHtml(p.name) + "</span>" +
        '<span class="repo-meta">' + escHtml(p.desc || "") + "</span>" +
        "</span>" +
        '<button type="button" class="repo-test-btn" title="Проверить провайдера: что отвечает g4f и какие модели отдаёт (логи — в консоль)">▶</button>' +
        (isSelected ? '<span class="repo-check">✓</span>' : "");
      const testBtn = item.querySelector(".repo-test-btn");
      if (testBtn) {
        testBtn.onclick = (e) => {
          e.stopPropagation();
          testG4fProvider(p);
        };
      }
      item.onclick = () => {
        // «default» — авто-режим G4F: сам выберет провайдера и модель
        $("s-openai-model").value = p.name === "default" ? "default" : p.name + ":";
        $("s-openai-model").focus();
        // Сразу показываем модели провайдера (офлайн-подсказки из реестра),
        // затем тихо пробуем подгрузить точный список из запущенного g4f.
        renderModelHints("openai", p.name === "default" ? null : (p.models && p.models.length ? p.models : null));
        renderG4fProviderList();
        refreshG4fModels(p.name);
        setSettingsMsg(
          p.name === "default"
            ? "Авто-режим G4F: модель «default» — G4F сам подберёт провайдера. Сохрани настройки и общайся."
            : (p.models && p.models.length
                ? "Провайдер «" + p.name + "» выбран — его модели показаны ниже, нажми нужную. Точный список от g4f подтягивается автоматически."
                : "Маршрут через «" + p.name + "» вставлен в поле модели. Допиши имя модели (или нажми ↻, чтобы увидеть список моделей) и сохрани настройки."),
          false
        );
      };
      list.appendChild(item);
    }
  }

  // Счётчик запросов: ответ живого списка применяем, только если провайдер не сменился
  let g4fModelReqSeq = 0;
  // Живой список моделей G4F (после выбора провайдера). Тихий: если g4f не запущен —
  // ничего не делаем, остаются офлайн-подсказки из реестра (никаких ошибок в UI).
  async function refreshG4fModels(providerName) {
    if (!providerName || providerName === "default") return;
    const seq = ++g4fModelReqSeq;
    const prov = G4F_PROVIDERS.find((p) => p.name === providerName);
    const registryModels = (prov && prov.models) || [];
    try {
      const res = await requestModelsList();
      if (seq !== g4fModelReqSeq) return; // пользователь успел выбрать другого провайдера
      if (!Array.isArray(res) || !res.length) {
        // g4f молчит — оставляем реестровые подсказки провайдера как есть
        if (registryModels.length) renderModelHints("openai", registryModels);
        return;
      }
      // Реестровые модели провайдера — ПЕРВЫЕ (реальные имена: DeepSeek-V3, Qwen…),
      // живые алиасы от g4f дописываются следом; дубликаты убираются.
      // Так живой список НЕ подменяет настоящие модели провайдера.
      const prefix = providerName + ":";
      const known = G4F_PROVIDERS;
      const seen = new Set();
      const merged = [];
      for (const rm of registryModels) {
        const full = String(rm || "").trim();
        if (full && !seen.has(full)) {
          seen.add(full);
          merged.push(full);
        }
      }
      for (const m of res) {
        if (typeof m !== "string" || !m.trim()) continue;
        const i = m.indexOf(":");
        const hasPrefix = i > 0 && known.some((p) => p.name === m.slice(0, i));
        const full = hasPrefix ? m.trim() : prefix + m.trim();
        if (!seen.has(full)) {
          seen.add(full);
          merged.push(full);
        }
      }
      if (!merged.length) return;
      renderModelHints("openai", merged);
      setSettingsMsg(
        "Провайдер «" + providerName + "»: " + merged.length + " моделей (настоящие из реестра + алиасы от g4f) — нажми нужную ниже.",
        false
      );
    } catch {
      // g4f не отвечает — оставляем офлайн-подсказки из реестра
    }
  }

  // Кнопка «▶» у провайдера: полный тест — что отвечает g4f и какие модели отдаёт.
  // Логи идут в панель «Консоль» (правая панель, вкладка console).
  async function testG4fProvider(p) {
    if (!p) return;
    const base = $(URL_INPUT.openai).value.trim();
    const curVal = ($("s-openai-model").value || "").trim();
    let model = "";
    if (p.name !== "default" && curVal.toLowerCase().startsWith(p.name.toLowerCase() + ":")) {
      model = curVal.slice(p.name.length + 1).trim();
    } else if (p.name !== "default" && p.models && p.models.length) {
      model = p.models[0];
    }
    // Открываем консоль, чтобы логи было видно сразу
    switchSideTab("console");
    termAppend('<div class="term-server"><span class="ts-err">▶ Тест провайдера «' + esc(p.name) + "»…</span></div>");
    let result;
    if (isElectron && api.g4fTest) {
      result = await api.g4fTest({ url: base, provider: p.name, model });
    } else {
      termServerAppend('<span class="ts-err">Полный тест доступен в десктоп-приложении (в браузере локальный g4f недоступен).</span>');
      setSettingsMsg("Тест G4F доступен в приложении на ПК.", true);
      return;
    }
    const lines = (result && result.log) || [];
    let okCount = 0;
    let errCount = 0;
    for (const l of lines) {
      const cls = l.level === "err" ? "ts-err" : l.level === "ok" ? "ts-ok" : l.level === "warn" ? "ts-warn" : "ts-info";
      if (l.level === "err") errCount++;
      if (l.level === "ok") okCount++;
      termServerAppend('<span class="' + cls + '">' + esc(l.text) + "</span>");
    }
    const verdict = errCount
      ? "Провайдер «" + p.name + "»: есть проблемы — смотри логи в консоли (правая панель)."
      : okCount
        ? "Провайдер «" + p.name + "» отвечает — подробности в консоли."
        : "Провайдер «" + p.name + "»: ответов нет — подробности в консоли.";
    setSettingsMsg(verdict, !!errCount);
  }

  // Авто-подбор порта G4F: если в поле URL ничего не отвечает, а живой g4f есть
  // на 1337 / 8080 — подставляем рабочий адрес (только для localhost, чтобы не
  // затирать вручную вписанный туннель/сетевой адрес).
  async function probeG4fPort() {
    if (!isElectron || !api.g4fProbe) return;
    const input = $("s-openai-url");
    const current = (input.value || "").trim();
    try {
      const r = await api.g4fProbe({ url: current });
      if (!r || r.ok === false || !r.base) return;
      const norm = current.replace(/\/+$/, "");
      if (r.base === norm) return;
      if (/localhost|127\.0\.0\.1/i.test(current)) {
        input.value = r.base;
        setSettingsMsg("Найден живой G4F на «" + r.base + "» — URL обновлён автоматически. Сохрани настройки.", false);
      } else {
        setSettingsMsg("G4F отвечает на «" + r.base + "», а в поле указан «" + norm + "» — если это не тот адрес, поправь URL.", false);
      }
    } catch {}
  }

  // Скрытие/показ блока выбора провайдера при смене пресета и открытии настроек.
  // preset передаётся от кликнутого чипа, потому что наш слушатель срабатывает
  // раньше setPreset() и currentPreset ещё не обновился.
  function syncG4fProviderBox(preset) {
    const box = $("g4f-provider-box");
    if (!box) return;
    const active = preset || currentPreset;
    box.classList.toggle("hidden", active !== "g4f");
    if (active === "g4f") {
      renderG4fProviderList();
      // Авто-подбор порта при открытии настроек (не чаще раза в 30 секунд)
      const now = Date.now();
      if (now - g4fProbeLastTs > 30000) {
        g4fProbeLastTs = now;
        probeG4fPort();
      }
    }
  }
  function wireG4fProviderPicker() {
    const head = $("g4f-provider-head");
    const search = $("g4f-provider-search");
    const clear = $("g4f-provider-clear");
    if (head) {
      head.onclick = () => {
        const body = $("g4f-provider-body");
        const chev = $("g4f-prov-chev");
        const opening = body.classList.contains("hidden");
        body.classList.toggle("hidden", !opening);
        if (chev) chev.textContent = opening ? "▾" : "▸";
        if (opening) renderG4fProviderList();
      };
    }
    if (search && clear) {
      search.addEventListener("input", () => {
        g4fProviderQuery = search.value;
        clear.classList.toggle("hidden", !search.value.trim());
        renderG4fProviderList();
      });
      search.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          search.value = "";
          g4fProviderQuery = "";
          clear.classList.add("hidden");
          renderG4fProviderList();
        }
      });
      clear.onclick = () => {
        search.value = "";
        g4fProviderQuery = "";
        clear.classList.add("hidden");
        renderG4fProviderList();
      };
    }
    // Переключение пресетов (чипы в настройках) и открытие окна настроек
    document.querySelectorAll(".chip[data-preset]").forEach((c) => {
      c.addEventListener("click", () => syncG4fProviderBox(c.dataset.preset));
    });
    const overlay = $("settings-overlay");
    if (overlay && window.MutationObserver) {
      new MutationObserver(() => {
        if (!overlay.classList.contains("hidden")) syncG4fProviderBox();
      }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
    }
  }
  // Элементы настроек уже в DOM (скрипты в конце body) — вешаем события сразу
  wireG4fProviderPicker();

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Миграция старых настроек (provider:"external", externalUrl, apiKey) в новую схему
  function normalize(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    if (s.provider === "external") s.provider = "openai";
    if (raw && raw.openaiUrl === undefined && raw.externalUrl !== undefined) s.openaiUrl = raw.externalUrl;
    if (raw && raw.openaiApiKey === undefined && raw.apiKey !== undefined) s.openaiApiKey = raw.apiKey;
    // Миграция на сохранённые OpenAI-подключения: единственный URL+ключ → первый профиль.
    if (!raw || !Array.isArray(raw.openaiProfiles)) {
      const profUrl = String(s.openaiUrl || "").trim();
      if (profUrl) {
        s.openaiProfiles = [{ id: "p-main", name: profileNameFromUrl(profUrl), url: profUrl, apiKey: s.openaiApiKey || "", model: s.openaiModel || "", project: s.openaiProject || "" }];
        s.openaiActiveProfile = "p-main";
      } else {
        s.openaiProfiles = [];
        s.openaiActiveProfile = "";
      }
    }
    return s;
  }

  // ─────────────── Хранилище ───────────────
  function loadState() {
    if (isElectron) {
      return Promise.all([api.getSettings(), api.loadChats()]).then(([s, c]) => {
        settings = normalize(s);
        chatsData = sanitizeChats(c || { chats: [], activeId: null });
        persistChats();
      });
    }
    try {
      settings = normalize(JSON.parse(localStorage.getItem("settings") || "null"));
    } catch {}
    try {
      chatsData = sanitizeChats(JSON.parse(localStorage.getItem("chats") || "null") || { chats: [], activeId: null });
    } catch {}
    return Promise.resolve();
  }

  // ─── Восстановление после аварийного закрытия ───
  // В сохранённой истории могли остаться незавершённые сообщения (pending).
  // Снимаем флаги, чтобы после перезапуска не висел вечный индикатор «выполняется»,
  // и один раз поясняем, что ответ был прерван.
  function sanitizeChats(d) {
    if (!d || !Array.isArray(d.chats)) return d || { chats: [], activeId: null };
    for (const c of d.chats) {
      if (!Array.isArray(c.messages)) c.messages = [];
      // План работ сохраняется вместе с чатом. Битые пункты (старый формат,
      // ручная правка файла) чистим тем же нормализатором, что и данные модели.
      // Защищается try/catch: sanitizeChats работает с файлом чатов при запуске и
      // не должен падать ни при каких данных (битый chats.json — не повод не стартовать).
      try {
        // Поле трогаем только если оно есть: чаты без плана не должны менять форму
        // (иначе каждый запуск перезаписывал бы весь файл истории).
        if (c.plan !== undefined) {
          const pi = c.plan && typeof c.plan === "object" && Array.isArray(c.plan.items) ? normalizePlanTasks(c.plan.items) : [];
          // legacy-планы со source "auto" отбрасываем — панель показывает только план модели.
          if (pi.length && c.plan.source !== "auto") c.plan = { title: String(c.plan.title || ""), source: c.plan.source === "text" ? "text" : "model", items: pi, updatedAt: Number(c.plan.updatedAt) || Date.now() };
          else c.plan = null;
        }
        if (Array.isArray(c.planHistory)) c.planHistory = c.planHistory.slice(0, PLAN_ARCHIVE_LIMIT);
      } catch { c.plan = null; c.planHistory = []; }
      let interrupted = false;
      for (const m of c.messages) {
        if (!m.pending) continue;
        m.pending = false;
        interrupted = true;
        if (m.role === "tool") {
          if (!m.toolResult) {
            m.toolResult = "Действие не завершилось: приложение закрылось раньше.";
            m.toolOk = false;
          }
        } else if (!m.content) {
          m.content = "…";
        }
      }
      if (interrupted && c.id === d.activeId) {
        c.messages.push({
          id: "recovered-" + c.id + "-" + Date.now(),
          role: "system",
          content: "⚠️ Предыдущий ответ был прерван закрытием приложения. Сохранённая часть осталась в истории — можно продолжить с этого места.",
          interrupted: true,
          chatId: c.id,
          createdAt: Date.now(),
        });
      }
    }
    return d;
  }
  function persistSettings() {
    if (isElectron) api.setSettings(settings);
    else localStorage.setItem("settings", JSON.stringify(settings));
  }
  function persistChats() {
    if (isElectron) api.saveChats(chatsData);
    else localStorage.setItem("chats", JSON.stringify(chatsData));
  }
  // ─── Автосохранение во время длинного ответа ───
  // Раньше чат писался на диск только в начале и в конце хода. Если приложение
  // закрыть посреди ответа, весь уже полученный текст и действия пропадали.
  // Теперь пишем не чаще раза в 1.5 c и гарантированно сбрасываем данные
  // при закрытии/сворачивании окна.
  let chatsSaveTimer = null;
  let chatsSavePending = false;
  const CHATS_SAVE_INTERVAL = 1500;
  function persistChatsSoon() {
    chatsSavePending = true;
    if (chatsSaveTimer) return;
    chatsSaveTimer = setTimeout(() => {
      chatsSaveTimer = null;
      if (!chatsSavePending) return;
      chatsSavePending = false;
      persistChats();
    }, CHATS_SAVE_INTERVAL);
  }
  function persistChatsNow() {
    if (chatsSaveTimer) { clearTimeout(chatsSaveTimer); chatsSaveTimer = null; }
    chatsSavePending = false;
    persistChats();
  }
  function flushChats(sync) {
    if (chatsSaveTimer) { clearTimeout(chatsSaveTimer); chatsSaveTimer = null; }
    if (!chatsSavePending) return;
    chatsSavePending = false;
    if (isElectron) {
      // Синхронный канал доступен в Electron: успевает записать файл при закрытии окна.
      if (sync && typeof api.saveChatsSync === "function") {
        try { api.saveChatsSync(chatsData); return; } catch {}
      }
      api.saveChats(chatsData);
    } else {
      localStorage.setItem("chats", JSON.stringify(chatsData));
    }
  }
  window.addEventListener("beforeunload", () => flushChats(true));
  window.addEventListener("pagehide", () => flushChats(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushChats(true);
  });

  // ─────────────── Чат ───────────────
  function getActiveChat() {
    return chatsData.chats.find((c) => c.id === chatsData.activeId) || null;
  }
  function createChat(opts) {
    opts = opts || {};
    const c = { id: uid(), title: opts.title || "Новый чат", projectId: settings.activeProjectId || "", createdAt: Date.now(), messages: [] };
    if (opts.contextMsg) c.messages.push({ id: uid(), role: "system", content: opts.contextMsg, createdAt: Date.now() });
    chatsData.chats.unshift(c);
    chatsData.activeId = c.id;
    renderSidebar();
    renderMessages();
    persistChats();
    return c;
  }
  // Найти чат, привязанный к проекту, или создать новый (с именем проекта).
  function ensureProjectChat(projectId, projectName) {
    if (!projectId) return;
    let chat = chatsData.chats.find((c) => c.projectId === projectId);
    if (!chat) {
      chat = createChat();
      chat.projectId = projectId;
      chat.title = projectName || "Новый чат";
      persistChats();
      renderSidebar();
      renderMessages();
    } else {
      selectChat(chat.id);
    }
    return chat;
  }
  function chatTitle(c) {
    const firstUser = c.messages.find((m) => m.role === "user");
    if (firstUser) {
      const t = msgText(firstUser.content) || "📷 Изображение";
      return t.slice(0, 42) + (t.length > 42 ? "…" : "");
    }
    // Чат, привязанный к проекту, без сообщений — показываем имя проекта.
    if (c.title && c.title !== "Новый чат") return c.title;
    const d = new Date(c.createdAt);
    const pad = (n) => String(n).padStart(2, "0");
    return "Чат " + pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function deleteChat(id) {
    if (streaming) return;
    chatsData.chats = chatsData.chats.filter((c) => c.id !== id);
    if (chatsData.activeId === id) chatsData.activeId = chatsData.chats[0] ? chatsData.chats[0].id : null;
    renderSidebar();
    renderMessages();
    persistChats();
  }
  function selectChat(id) {
    if (streaming) return;
    const chat = chatsData.chats.find((c) => c.id === id);
    // Чат привязан к другому проекту — переключаемся на этот проект,
    // чтобы агент работал в правильной рабочей директории и с чистым контекстом.
    if (chat && chat.projectId && isElectron && chat.projectId !== settings.activeProjectId) {
      switchProject(chat.projectId);
      return;
    }
    chatsData.activeId = id;
    renderSidebar();
    renderMessages();
    persistChats();
  }

  // ─────────── План работ (todoWrite): панель-чеклист над панелью действий ───────────
  // Панель показывает ТОЛЬКО план, составленный моделью инструментом todoWrite.
  // Если модель плана не дала — панели нет вовсе: ход её действий и так виден в панели
  // работы над полем ввода, а дублирующий чеклист «что уже сделано» только путал
  // и выглядел ошибкой интерфейса.
  // Функции ниже чистые: они меняют только переданный объект чата и ничего не рисуют —
  // отрисовку и запись на диск делают вызывающие места (так это и тестируется).
  const PLAN_ICON = { pending: "⬜", in_progress: "🔄", done: "✅", failed: "⚠️" };
  const PLAN_TEXT = { pending: "ожидает", in_progress: "в работе", done: "готово", failed: "не удалось" };
  const PLAN_ARCHIVE_LIMIT = 5;

  function planProgress(items) {
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const done = list.filter((i) => i && i.status === "done").length;
    const failed = list.filter((i) => i && i.status === "failed").length;
    const active = list.find((i) => i && i.status === "in_progress");
    const percent = total ? Math.round(((done + failed) / total) * 100) : 0;
    return { total, done, failed, percent, active: active ? active.text : "", finished: total > 0 && done + failed === total };
  }

  function planArchive(chat, plan) {
    if (!chat || !plan || !Array.isArray(plan.items) || !plan.items.length) return;
    if (!Array.isArray(chat.planHistory)) chat.planHistory = [];
    chat.planHistory.unshift({
      title: plan.title || "",
      source: plan.source || "model",
      items: plan.items,
      updatedAt: plan.updatedAt || Date.now(),
    });
    if (chat.planHistory.length > PLAN_ARCHIVE_LIMIT) chat.planHistory.length = PLAN_ARCHIVE_LIMIT;
  }

  // План от модели (todoWrite). Слабая модель может прислать мусор — нормализатор
  // вернёт пустой список, и такой «план» просто не появится.
  function planFromModel(chat, ev) {
    if (!chat) return false;
    const items = normalizePlanTasks(ev && ev.tasks);
    if (!items.length) return false;
    // Заменяя план модели, предыдущий убираем в историю (не теряем контекст).
    if (chat.plan && chat.plan.source !== "auto") planArchive(chat, chat.plan);
    chat.plan = {
      title: String((ev && ev.title) || "").trim().slice(0, 80),
      source: "model",
      items,
      updatedAt: Date.now(),
    };
    return true;
  }

  // ── План, написанный моделью ТЕКСТОМ (не через todoWrite) ──
  // Слабые модели часто перечисляют шаги прямо в ответе («План: 1. … 2. …»). Раньше такой
  // план пропадал: панель питалась только todoWrite, и получалось «план составляет, а панели
  // с галочками нет». Теперь текст тоже становится чеклистом: заголовок («План», «План работ»,
  // «Шаги», «Todo») со списком пунктов или блок строк-чекбоксов (✅/⬜/🔄/⚠️).
  const PLAN_TEXT_MAX = 7;
  const PLAN_HEAD_RE = /^\s*(?:[>#*_]{0,4}\s*)?(?:\*\*|__)?\s*(план(?:\s+(?:работ|действий|выполнения|задач))?|шаги|порядок\s+действий|todo|to-do)\s*:?\s*(?:\*\*|__)?\s*$/i;
  // Заголовок в КОНЦЕ фразы, а не отдельной строкой: «План уже составлен. Сейчас нужно:», «Дальше по шагам:».
  // Ключевое слово обязательно: иначе любой абзац «что нужно:» со списком выглядел бы планом.
  const PLAN_TAIL_RE = /(?:план\w*|шаг\w*|этап\w*|дальше|теперь|нужно|надо|осталось|порядок\s+действий)[^:\n]{0,60}:\s*$/i;
  const PLAN_ITEM_RE = /^\s*(?:[-*•–—]\s+\S|\[[ xX]\]\s*\S|\d{1,2}[.)]\s+\S|[✅☑✔⬜☐🔄⚠️⬛]\s*\S)/;
  const PLAN_TICK_RE = /^\s*[✅☑✔⬜☐🔄⚠️⬛]\s*\S/;

  // Строки плана из текста ответа. Пусто — если плана в тексте нет (обычный ответ или
  // перечисление в прозе): заголовок обязателен, либо нужен блок чекбоксов из 2+ строк.
  function planLinesFromText(text) {
    const lines = String(text || "").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!PLAN_HEAD_RE.test(lines[i]) && !PLAN_TAIL_RE.test(lines[i])) continue;
      const out = [];
      for (let j = i + 1; j < lines.length && out.length < PLAN_TEXT_MAX; j++) {
        const line = lines[j].replace(/\s+$/, "");
        if (!line.trim()) { if (out.length) break; continue; }
        if (!PLAN_ITEM_RE.test(line)) break; // пошёл обычный текст — план закончился
        out.push(line);
      }
      if (out.length >= 2) return out;
    }
    // Заголовка нет, но есть блок строк-чекбоксов — это тоже план (его и ждёт пользователь).
    let block = [];
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (PLAN_TICK_RE.test(line)) { block.push(line); continue; }
      if (!line.trim() && block.length) continue;
      if (block.length >= 2) break;
      block = [];
    }
    return block.length >= 2 ? block.slice(0, PLAN_TEXT_MAX) : [];
  }

  // Заголовок плана из текста («План работ» и т.п.). Пусто → панель покажет «План работ».
  function planTitleFromText(text) {
    for (const line of String(text || "").split(/\r?\n/)) {
      const m = line.match(PLAN_HEAD_RE);
      if (!m || !m[1]) continue;
      const t = String(m[1]).trim();
      if (t) return t.charAt(0).toUpperCase() + t.slice(1);
    }
    return "";
  }

  // План из текста. Настоящий план модели (todoWrite) всегда важнее текстового.
  function planFromText(chat, text) {
    if (!chat) return false;
    if (chat.plan && chat.plan.source === "model") return false;
    const lines = planLinesFromText(text);
    if (lines.length < 2) return false;
    const items = normalizePlanTasks(lines);
    if (items.length < 2) return false; // один пункт — это фраза, а не план
    if (chat.plan && chat.plan.source === "text") {
      const old = chat.plan.items;
      const same = old.map((i) => i.text).join("|") === items.map((i) => i.text).join("|");
      if (same) return false; // тот же план — статусы не сбрасываем
      // План печатается прямо сейчас: старые пункты — начало нового списка. Значит это ТОТ ЖЕ
      // план, просто стрим дошёл до следующих строк: в историю его не убираем, а статусы уже
      // пройденных пунктов сохраняем (иначе галочки прыгали бы назад на каждом куске).
      const grows = old.length <= items.length && old.every((it, i) => it.text === items[i].text);
      if (grows) {
        for (let i = 0; i < old.length; i++) items[i].status = old[i].status;
        chat.plan = { title: planTitleFromText(text), source: "text", items, updatedAt: Date.now() };
        return true;
      }
      planArchive(chat, chat.plan);
    }
    chat.plan = { title: planTitleFromText(text), source: "text", items, updatedAt: Date.now() };
    return true;
  }

  // Прогресс текстового плана: модель статусы не присылает, поэтому галочки двигает сам факт
  // работы — перед раундом действий первый пункт встаёт «в работе», после раунда — готов.
  function planTextAdvance(chat, ok) {
    if (!chat || !chat.plan || chat.plan.source !== "text" || !Array.isArray(chat.plan.items)) return false;
    const items = chat.plan.items;
    const cur = items.find((i) => i.status === "in_progress");
    if (!cur) {
      const first = items.find((i) => i.status === "pending");
      if (!first) return false;
      first.status = "in_progress";
      chat.plan.updatedAt = Date.now();
      return true;
    }
    if (!ok) return false; // провал шага отмечает planToolOutcome
    cur.status = "done";
    const next = items.find((i) => i.status === "pending");
    if (next) next.status = "in_progress";
    chat.plan.updatedAt = Date.now();
    return true;
  }

  // Запуск закончился: незакрытый пункт текстового плана отмечаем готовым.
  function planTextFinish(chat) {
    if (!chat || !chat.plan || chat.plan.source !== "text" || !Array.isArray(chat.plan.items)) return false;
    const cur = chat.plan.items.find((i) => i.status === "in_progress");
    if (!cur) return false;
    cur.status = "done";
    chat.plan.updatedAt = Date.now();
    return true;
  }

  // Начался новый раунд ответа (текст или размышления после действий) — предыдущий пункт
  // текстового плана фактически выполнен. Один пункт на раунд: segId защищает от повторов
  // (размышления и текст в одном раунде открывают сегмент лишь один раз).
  function planRoundStarted(chat, segId) {
    if (!chat || !chat.plan || chat.plan.source !== "text") return false;
    if (!segId || chat.plan.advancedFor === segId) return false;
    if (!planTextAdvance(chat, true)) return false;
    chat.plan.advancedFor = segId;
    renderPlanPanel();
    persistChatsSoon();
    return true;
  }

  // Весь текст текущего запуска — ответ И размышления: источник для разбора плана.
  // Размышления обязательны: слабые и локальные модели пишут план именно там
  // («План уже составлен. Сейчас нужно: 1. … 2. …»), а в самом ответе плана нет вовсе —
  // поэтому панель и оставалась пустой, хотя модель «составила план».
  function runTextOf(chat, aMsg) {
    const parts = [];
    for (const s of runSegments(chat, aMsg)) {
      if (!s) continue;
      if (s.thinking) parts.push(String(s.thinking));
      if (s.content) parts.push(String(s.content));
    }
    return parts.join("\n");
  }

  // Разбор плана из текста запуска. Во время стрима вызывается на каждом куске, поэтому
  // сначала дешёвый гейт: без нескольких строк плана быть не может — регекспы не гоняем.
  function tryPlanFromRunText(chat, aMsg) {
    const text = runTextOf(chat, aMsg);
    if ((text.match(/\n/g) || []).length < 2) return false;
    if (planFromText(chat, runTextOf(chat, aMsg))) {
      planCollapsed = false; // план только что появился — показываем его развёрнутым
      renderPlanPanel();
      persistChatsSoon();
      return true;
    }
    return false;
  }

  // Результат инструмента. Статусы пунктов ведёт модель, но если её текущий шаг
  // фактически упал — показываем ⚠️, а не «в работе»: слепо доверять плану нельзя.
  function planToolOutcome(chat, ev, ok) {
    if (!chat || !chat.plan || !Array.isArray(chat.plan.items)) return false;
    if (!ok) {
      for (let i = chat.plan.items.length - 1; i >= 0; i--) {
        const it = chat.plan.items[i];
        if (it.status !== "in_progress") continue;
        it.status = "failed";
        if (!it.note) it.note = "шаг не удался — см. результат инструмента";
        chat.plan.updatedAt = Date.now();
        return true;
      }
    }
    return false;
  }

  // Новый запрос пользователя: завершённый план — в историю, незавершённый
  // остаётся (при «продолжай» агент видит, что осталось).
  function planRotate(chat) {
    if (!chat || !chat.plan) return false;
    if (planProgress(chat.plan.items).finished) { planArchive(chat, chat.plan); chat.plan = null; return true; }
    return false;
  }
  // ─────────── /План работ ───────────
  // Панель плана: отдельный контейнер над панелью действий — она не сбрасывается
  // вместе с ходом работ и не уезжает при прокрутке списка действий.
  let planCollapsed = false;
  function renderPlanPanel() {
    const host = $("plan-panel");
    if (!host) return;
    const chat = getActiveChat();
    // Панель только для плана модели. Старые авто-списки из chats.json (source "auto")
    // не показываем: они и есть тот самый «ход работы», который дублировал панель действий.
    const plan =
      chat && chat.plan && chat.plan.source !== "auto" && Array.isArray(chat.plan.items) && chat.plan.items.length
        ? chat.plan
        : null;
    if (!plan) {
      host.classList.add("hidden");
      host.innerHTML = "";
      return;
    }
    const pr = planProgress(plan.items);
    host.classList.remove("hidden");
    host.innerHTML = "";
    const group = document.createElement("div");
    group.className = "plan-group" + (pr.finished ? " finished" : "") + (planCollapsed ? "" : " expanded");

    const head = document.createElement("div");
    head.className = "plan-head";
    head.title = "Показать/скрыть план работ";
    head.onclick = (e) => {
      e.stopPropagation();
      planCollapsed = !planCollapsed;
      renderPlanPanel();
    };
    const dot = document.createElement("span");
    dot.className = "plan-dot";
    const title = document.createElement("span");
    title.className = "plan-title";
    title.textContent = "📋 " + (plan.title || "План работ");
    const count = document.createElement("span");
    count.className = "plan-count";
    count.textContent = pr.done + "/" + pr.total + (pr.failed ? " ⚠" + pr.failed : "");
    count.title = "Готово " + pr.done + " из " + pr.total + (pr.failed ? ", не удалось: " + pr.failed : "");
    head.appendChild(dot);
    head.appendChild(title);
    // Свёрнутая панель: видно, какой шаг выполняется прямо сейчас (разворачивать не нужно).
    if (planCollapsed && pr.active && !pr.finished) {
      const act = document.createElement("span");
      act.className = "plan-active";
      act.textContent = PLAN_ICON.in_progress + " " + pr.active;
      act.title = "Сейчас в работе: " + pr.active;
      head.appendChild(act);
    }
    head.appendChild(count);
    // Кнопка «выполнить план» — только когда план составлен моделью и ждёт запуска
    // (в режиме плана инструменты не выполнялись).
    if (planPending(chat)) {
      const run = document.createElement("button");
      run.className = "btn btn-primary btn-small plan-run";
      run.textContent = "▶ Выполнить";
      run.onclick = (e) => {
        e.stopPropagation();
        if (streaming) return;
        for (let i = chat.messages.length - 1; i >= 0; i--) {
          if (chat.messages[i].role === "assistant") { chat.messages[i].plan = false; break; }
        }
        const inp = $("input");
        inp.value = "Выполни план, который ты составил. Обновляй его через todoWrite после каждого шага.";
        autoResize();
        sendMessage();
      };
      head.appendChild(run);
    }
    const clear = document.createElement("button");
    clear.className = "plan-clear";
    clear.textContent = "✕";
    clear.title = "Убрать план с экрана (уйдёт в историю планов чата)";
    clear.onclick = (e) => {
      e.stopPropagation();
      planArchive(chat, chat.plan);
      chat.plan = null;
      renderPlanPanel();
      persistChatsSoon();
    };
    const chev = document.createElement("span");
    chev.className = "plan-chev";
    chev.textContent = planCollapsed ? "▸" : "▾";
    head.appendChild(clear);
    head.appendChild(chev);
    group.appendChild(head);

    const bar = document.createElement("div");
    bar.className = "plan-bar";
    const fill = document.createElement("div");
    fill.className = "plan-fill";
    fill.style.width = pr.percent + "%";
    bar.appendChild(fill);
    group.appendChild(bar);

    const body = document.createElement("div");
    body.className = "plan-body";
    for (const it of plan.items) {
      const row = document.createElement("div");
      row.className = "plan-item " + (PLAN_ICON[it.status] ? "st-" + it.status : "st-pending");
      const ic = document.createElement("span");
      ic.className = "plan-ic";
      ic.textContent = PLAN_ICON[it.status] || PLAN_ICON.pending;
      const tx = document.createElement("span");
      tx.className = "plan-txt";
      tx.textContent = it.text;
      row.appendChild(ic);
      row.appendChild(tx);
      if (it.note) {
        const nt = document.createElement("span");
        nt.className = "plan-note";
        nt.textContent = it.note;
        row.appendChild(nt);
      } else {
        row.title = PLAN_TEXT[it.status] || "";
      }
      body.appendChild(row);
    }
    group.appendChild(body);
    host.appendChild(group);
  }

  // Ждёт ли план запуска: последний ответ ассистента помечен режимом плана.
  function planPending(chat) {
    if (!chat || !Array.isArray(chat.messages)) return false;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m.role !== "assistant") continue;
      return !!m.plan;
    }
    return false;
  }
  // ─────────────── Рендер ───────────────
  function renderSidebar() {
    const list = $("chat-list");
    list.innerHTML = "";
    for (const c of chatsData.chats) {
      const item = document.createElement("div");
      item.className = "chat-item" + (c.id === chatsData.activeId ? " active" : "");
      const title = document.createElement("div");
      title.className = "chat-title";
      title.textContent = chatTitle(c);
      // Подпись проекта, если чат привязан к проекту.
      if (c.projectId) {
        const pr = (settings.projects || []).find((p) => p.id === c.projectId);
        if (pr) {
          const tag = document.createElement("div");
          tag.className = "chat-project";
          tag.textContent = "📁 " + pr.name;
          tag.title = pr.dir || "";
          title.appendChild(tag);
        }
      }
      const del = document.createElement("button");
      del.className = "chat-del";
      del.textContent = "🗑";
      del.title = "Удалить чат";
      del.onclick = (e) => {
        e.stopPropagation();
        deleteChat(c.id);
      };
      item.appendChild(title);
      item.appendChild(del);
      item.onclick = () => selectChat(c.id);
      list.appendChild(item);
    }
  }

  function renderMessages() {
    maybeRestoreUndoButton();
    updateModelNeeded();
    renderPlanPanel();
    const wrap = $("messages");
    wrap.innerHTML = "";
    msgEls.clear();
    const chat = getActiveChat();
    const welcome = $("welcome");
    if (!chat || !chat.messages.length) {
      $("chat-title").textContent = chat ? chatTitle(chat) : "Новый чат";
      welcome.classList.remove("hidden");
      // Сразу даём печатать: фокус в композер, чтобы не приходилось сначала
      // жать кнопку-карточку (раньше оверлей перехватывал клики по полю ввода).
      if (!streaming) {
        requestAnimationFrame(() => {
          const inp = $("input");
          if (inp && document.activeElement !== inp) inp.focus();
        });
      }
      return;
    }
    welcome.classList.add("hidden");
    $("chat-title").textContent = chatTitle(chat);
    for (const m of chat.messages) wrap.appendChild(buildMessageEl(m));
    pinnedToBottom = true; // при переключении чата всегда прыгаем вниз
    scrollBottom();
  }

  function buildMessageEl(m) {
    let el;
    if (m.role === "tool") el = buildToolEl(m);
    else el = buildBubbleEl(m);
    msgEls.set(m.id, el);
    return el;
  }

  // content сообщения может быть строкой или массивом частей
  // [{type:"text",text},{type:"image_url",image_url:{url}}] — вложения-скриншоты.
  function msgText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
    }
    return "";
  }
  function msgHtml(content) {
    if (typeof content === "string") return MdRender.render(content);
    if (Array.isArray(content)) {
      let h = "";
      for (const p of content) {
        if (!p) continue;
        if (p.type === "image_url" && p.image_url && p.image_url.url) {
          h += '<div class="md-attach"><img src="' + MdRender.esc(p.image_url.url) + '" alt="изображение" /></div>';
        }
      }
      const txt = msgText(content);
      if (txt) h += MdRender.render(txt);
      return h;
    }
    return "";
  }

  // ─── Размышления модели (как в Replit) — блок над ответом, свёртывается по клику ───
  // При стриминге раскрыт и обновляется вживую; по завершении автоматически
  // сворачивается в одну строку (если пользователь сам не открыл его кликом).
  // Автопрокрутка размышлений: текст растёт — блок сам едет вниз, читать
  // конец вручную не нужно. Если пользователь отлистал вверх (читает ранее
  // написанное) — не выдёргиваем его и возвращаемся к автопрокрутке, когда он
  // снова окажется у конца.
  function thinkAutoScroll(body, force) {
    if (!body) return;
    if (!force && body.dataset && body.dataset.pinned === "0") return;
    if (body.dataset) body.dataset.pinned = "1";
    body.scrollTop = body.scrollHeight;
  }

  function ensureThinkBox(el, text) {
    let box = el.querySelector(".think");
    if (!box) {
      box = document.createElement("div");
      box.className = "think";
      const head = document.createElement("div");
      head.className = "think-head";
      const ic = document.createElement("span");
      ic.className = "think-ic";
      ic.textContent = "💭";
      const tt = document.createElement("span");
      tt.className = "think-t";
      tt.textContent = "Размышление";
      const chev = document.createElement("span");
      chev.className = "think-chev";
      chev.textContent = "▾";
      head.appendChild(ic);
      head.appendChild(tt);
      head.appendChild(chev);
      const body = document.createElement("div");
      body.className = "think-body";
      body.textContent = text || "";
      // Следим, у конца ли пользователь: ушёл вверх — автопрокрутку не навязываем.
      body.addEventListener("scroll", () => {
        const nearEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        body.dataset.pinned = nearEnd ? "1" : "0";
      });
      head.onclick = (e) => {
        e.stopPropagation();
        box.classList.add("user"); // управление вручную — автосворачивание больше не трогает блок
        const collapsed = box.classList.toggle("collapsed");
        chev.textContent = collapsed ? "▸" : "▾";
        if (!collapsed) thinkAutoScroll(body, true); // развернули — сразу показываем конец
      };
      thinkAutoScroll(body, true);
      box.appendChild(head);
      box.appendChild(body);
      const bubble = el.querySelector(".bubble");
      if (bubble) el.insertBefore(box, bubble);
      else el.appendChild(box);
    } else {
      const body = box.querySelector(".think-body");
      if (body && body.textContent !== (text || "")) {
        body.textContent = text || "";
        thinkAutoScroll(body); // текст вырос — едем вниз вместе с ним
      }
    }
    return box;
  }

  function buildBubbleEl(m) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (m.error ? "error" : m.role);
    const bubble = document.createElement("div");
    bubble.className = "bubble" + (m.pending ? " pending" : "");
    if (m.error) {
      bubble.textContent = m.error;
    } else {
      bubble.classList.add("md");
      bubble.innerHTML = msgHtml(m.content);
    }
    wrap.appendChild(bubble);
    if (m.createdAt) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = fmtClock(m.createdAt);
      wrap.appendChild(meta);
    }
    // Прерванный ответ (приложение закрыли посреди хода): кнопка «Дописать ответ»
    if (m.role === "system" && m.interrupted) {
      const row = document.createElement("div");
      row.className = "msg-actions";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ma-btn";
      b.textContent = "↻ Дописать ответ";
      b.title = "Продолжить прерванный ответ с того места, где он остановился";
      b.onclick = (e) => {
        e.stopPropagation();
        if (row.parentNode) row.parentNode.removeChild(row);
        continueInterruptedAnswer(m.chatId || chatsData.activeId, m);
      };
      row.appendChild(b);
      wrap.appendChild(row);
    }
    // Сохранённые размышления (после перезагрузки/переключения чата) — свёрнуты
    if (m.role === "assistant" && m.thinking) {
      const box = ensureThinkBox(wrap, m.thinking);
      if (!m.pending) {
        box.classList.add("collapsed");
        const ch = box.querySelector(".think-chev");
        if (ch) ch.textContent = "▸";
      }
    }
    // Кнопки действий под сообщением: копировать, перегенерировать, редактировать
    if (!m.pending && (m.role === "user" || (m.role === "assistant" && !m.error))) {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const addBtn = (label, title, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ma-btn";
        b.textContent = label;
        b.title = title;
        b.onclick = fn;
        actions.appendChild(b);
      };
      if (m.role === "assistant") {
        addBtn("⧉", "Скопировать ответ", () => copyText(msgText(m.content)));
        if (isLastAssistant(m)) addBtn("↻", "Сгенерировать ответ заново", () => regenerate(m));
      } else if (m.role === "user") {
        addBtn("⧉", "Скопировать сообщение", () => copyText(msgText(m.content)));
        addBtn("✏️", "Редактировать — вставить в поле ввода и переотправить", () => editUserMessage(m));
      }
      wrap.appendChild(actions);
    }
    return wrap;
  }

  const TOOL_ICON = {
    createFolder: "📁",
    readFile: "📄",
    writeFile: "✏️",
    listDirectory: "📂",
    gitClone: "🧬",
    gitStatus: "📊",
    gitCommit: "💾",
    gitPush: "📤",
    gitPull: "📥",
    gitLog: "📜",
    gitRevert: "↩️",
    readFileLines: "📑",
    editFile: "✂️",
    searchFile: "🔍",
    searchProject: "🔎",
    fileOutline: "🧭",
    listFiles: "🗂️",
    runCommand: "💻",
    webSearch: "🌐",
    webFetch: "🌍",
    browserOpen: "🌐",
    browserFill: "⌨️",
    browserClick: "🖱️",
    browserAct: "⚡",
    browserEval: "🧪",
    browserDOM: "🧩",
    browserOverlays: "🪟",
    browserSelect: "🔽",
    browserPress: "⌨️",
    browserText: "📄",
    browserScreenshot: "📷",
    browserWait: "⏳",
    browserScroll: "↕️",
    browserHover: "👆",
    browserNetwork: "📡",
    waitForIdle: "⏸",
    agentGuide: "📘",
    browserClose: "🚪",
    browserStatus: "🗔",
    appRead: "👁️",
    appClick: "🖱️",
    appFill: "⌨️",
    appSelect: "🔽",
    appPress: "🔑",
    appWait: "⏳",
    appScreenshot: "📷",
    askUser: "❓",
    startBackground: "🔄",
    listBackground: "📋",
    backgroundOutput: "📜",
    sendInput: "⌨️",
    stopBackground: "⏹️",
    shellStart: "🖥️",
    shellSend: "💬",
    checkUrl: "🌐",
    openUrl: "🔗",
    showImage: "🖼️",
    checkPort: "🔌",
    listPorts: "🔎",
    dockerBuild: "🐳",
    dockerRun: "🐳",
    dockerExec: "🐳",
    installPackage: "📦",
    lintProject: "🧹",
    runTests: "🧪",
    diffView: "🔀",
    previewUI: "🖥️",
    screenshotCapture: "📸",
    analyzeImage: "👁",
    generateImage: "🎨",
    envSet: "🔑",
    envList: "🗝️",
    envUnset: "🗑️",
    readFileStructure: "📇",
    explainCode: "💡",
    undoEdit: "↩️",
    refactorRename: "♻️",
    runCommandOutput: "🔄",
    apiRequest: "🌐",
    runScript: "▶️",
    validateProject: "🛡️",
    gitBranch: "🌿",
    gitCheckout: "🔀",
    findReferences: "🎯",
    gitDiff: "⇄",
    gitUndoLastCommit: "⏪",
    getDependencies: "📦",
    formatCode: "✨",
    dbQuery: "🗄️",
    listProcesses: "📊",
    killProcess: "💥",
    clipboardRead: "📋",
    clipboardWrite: "📝",
    screenshotDesktop: "🪟",
    registryRead: "🗃️",
    registryWrite: "🗃️",
    openPath: "📂",
    wingetSearch: "🧲",
    installExe: "⚙️",
  };

  const TOOL_LABEL = {
    createFolder: "Создание папки",
    readFile: "Чтение файла",
    writeFile: "Изменение файла",
    listDirectory: "Список файлов",
    gitClone: "Клонирование репозитория",
    gitStatus: "git status",
    gitCommit: "Коммит изменений",
    gitPush: "Отправка на GitHub",
    gitPull: "Загрузка с GitHub",
    gitLog: "Журнал коммитов",
    gitRevert: "Откат коммита",
    readFileLines: "Чтение строк файла",
    editFile: "Правка фрагмента",
    searchFile: "Поиск по файлу",
    searchProject: "Поиск по проекту",
    fileOutline: "Карта файла",
    listFiles: "Файлы проекта",
    runCommand: "Команда в терминале",
    webSearch: "Поиск в интернете",
    webFetch: "Чтение страницы",
    browserOpen: "Открыть сайт в браузере",
    browserFill: "Заполнить поле",
    browserClick: "Клик",
    browserAct: "Цепочка действий в браузере",
    browserEval: "JS на странице",
    browserDOM: "Разбор HTML",
    browserOverlays: "Слои и помехи",
    browserSelect: "Выбор из списка",
    browserPress: "Нажатие клавиши",
    browserText: "Текст страницы",
    browserScreenshot: "Скриншот страницы",
    browserWait: "Ожидание элемента",
    browserScroll: "Прокрутка страницы",
    browserHover: "Наведение мыши",
    browserNetwork: "Запросы страницы",
    waitForIdle: "Ожидание покоя страницы",
    agentGuide: "Справочник агента",
    browserClose: "Закрыть вкладку",
    browserStatus: "Вкладки браузера",
    appRead: "Чтение окна приложения",
    appClick: "Клик в окне приложения",
    appFill: "Ввод в поле приложения",
    appSelect: "Выбор из списка",
    appPress: "Нажатие клавиши",
    appWait: "Ожидание элемента",
    appScreenshot: "Скриншот окна",
    askUser: "Вопрос пользователю",
    startBackground: "Запуск фонового процесса",
    listBackground: "Список фоновых процессов",
    backgroundOutput: "Вывод процесса",
    sendInput: "Ввод в процесс",
    stopBackground: "Остановка процесса",
    shellStart: "Запуск shell-сессии",
    shellSend: "Команда в shell",
    checkUrl: "Проверка URL",
    openUrl: "Открытие URL",
    showImage: "Показ изображения",
    checkPort: "Проверка порта",
    listPorts: "Список портов",
    dockerBuild: "Сборка Docker-образа",
    dockerRun: "Запуск Docker-контейнера",
    dockerExec: "Команда в Docker-контейнере",
    installPackage: "Установка пакета",
    lintProject: "Проверка кода",
    runTests: "Запуск тестов",
    diffView: "Сравнение файлов",
    previewUI: "Предпросмотр сайта",
    screenshotCapture: "Скриншот страницы",
    analyzeImage: "Анализ изображения",
    generateImage: "Генерация изображения",
    envSet: "Задать переменную окружения",
    envList: "Список переменных окружения",
    envUnset: "Удалить переменную окружения",
    readFileStructure: "Структура файла",
    explainCode: "Объяснение кода",
    undoEdit: "Откат правки файла",
    refactorRename: "Переименование в проекте",
    runCommandOutput: "Команда с повтором",
    apiRequest: "HTTP-запрос",
    runScript: "Скрипт из package.json",
    validateProject: "Проверка проекта",
    gitBranch: "Ветки git",
    gitCheckout: "Переключение ветки",
    findReferences: "Ссылки на символ",
    gitDiff: "Сравнение веток",
    gitUndoLastCommit: "Отмена коммита (soft)",
    getDependencies: "Зависимости проекта",
    formatCode: "Форматирование кода",
    dbQuery: "SQL-запрос к БД",
    listProcesses: "Список процессов",
    killProcess: "Завершение процесса",
    clipboardRead: "Чтение буфера обмена",
    clipboardWrite: "Копирование в буфер",
    screenshotDesktop: "Скриншот экрана",
    registryRead: "Чтение реестра",
    registryWrite: "Запись в реестр",
    openPath: "Открытие файла",
    wingetSearch: "Поиск в winget",
    installExe: "Установка .exe",
  };

  function toolTargetOf(t) {
    const a = (t && t.args) || {};
    if (a.path) return String(a.path);
    if (a.url) return String(a.url);
    if (a.commit) return "commit " + String(a.commit);
    if (a.message) return "«" + String(a.message).slice(0, 50) + "»";
    if (a.query) return String(a.query).slice(0, 80);
    if (a.command) return String(a.command).slice(0, 60);
    if (a.question) return String(a.question).slice(0, 60);
    return "";
  }

  function toolArgsPreview(a) {
    const obj = {};
    for (const [k, v] of Object.entries(a || {})) {
      if (typeof v === "string" && v.length > 220) obj[k] = v.slice(0, 220) + "… (" + v.length + " симв.)";
      else obj[k] = v;
    }
    return JSON.stringify(obj, null, 1);
  }

  // Компактная строка действия агента (как во Freebuff/Replit):
  // [✓ файл/действие · Готово ▾] — клик раскрывает подробности
  function buildToolEl(m) {
    const wrap = document.createElement("div");
    wrap.className = "msg tool";
    const body = document.createElement("div");
    const isErr = m.toolOk === false;
    const isDone = !m.pending;
    body.className = "tool-body" + (isErr ? " err" : isDone ? " done" : " busy");
    const row = document.createElement("div");
    row.className = "tool-row";

    const state = document.createElement("span");
    state.className = "tool-state";
    state.textContent = isErr ? "✕" : isDone ? "✓" : "●";

    const ic = document.createElement("span");
    ic.className = "tool-ic";
    ic.textContent = TOOL_ICON[m.toolName] || "⚙️";

    const label = document.createElement("span");
    label.className = "tool-label";
    label.textContent = TOOL_LABEL[m.toolName] || m.toolName;

    const target = toolTargetOf(m);
    const tEl = document.createElement("span");
    tEl.className = "tool-target";
    tEl.textContent = target;
    tEl.title = target;
    // Файловые инструменты: клик по пути открывает файл в просмотрщике
    const FILE_TOOLS = ["readFile", "writeFile", "editFile", "readFileLines", "searchFile", "showImage"];
    if (target && isElectron && FILE_TOOLS.includes(m.toolName)) {
      tEl.classList.add("tool-target-link");
      tEl.title = "Открыть файл: " + target + " (клик)";
      tEl.onclick = (e) => {
        e.stopPropagation();
        openToolFile(target);
      };
    }

    const status = document.createElement("span");
    status.className = "tool-status " + (isErr ? "err" : isDone ? "ok" : "pending");
    status.textContent = isErr ? "Ошибка" : isDone ? "Готово" : "Выполняется";

    const chev = document.createElement("span");
    chev.className = "tool-chev";
    chev.textContent = "▾";

    row.appendChild(state);
    row.appendChild(ic);
    row.appendChild(label);
    if (target) row.appendChild(tEl);
    row.appendChild(status);
    row.appendChild(chev);

    const details = document.createElement("div");
    details.className = "tool-details";
    if (m.toolArgs && Object.keys(m.toolArgs).length) {
      const args = document.createElement("div");
      args.className = "tool-args";
      args.textContent = toolArgsPreview(m.toolArgs);
      details.appendChild(args);
    }
    if (m.toolResult) {
      const res = document.createElement("div");
      res.className = "tool-result";
      res.textContent = m.toolResult;
      details.appendChild(res);
    }

    body.appendChild(row);
    body.appendChild(details);
    body.title = "Клик — показать/скрыть подробности";
    body.onclick = (e) => {
      if (e.target.closest && !e.target.closest("a")) body.classList.toggle("open");
    };
    wrap.appendChild(body);
    return wrap;
  }

  // Открывает файл из строки действия агента в просмотрщике (панель проекта).
  function openToolFile(target) {
    const t = String(target || "").trim();
    if (!t) return;
    const isAbs = /^[a-zA-Z]:[\\/]|^[\\/]/.test(t);
    const base = projectDir().replace(/[\\/]+$/, "");
    const full = isAbs ? t : (base ? base + "/" + t : t);
    viewFile(full);
  }

  // ─── Ход работы: компактная группа строк действий текущего ответа ───
  // Строки действий (tool-сообщения) складываются в work.body, а над ними —
  // тонкий заголовок «Выполняю действия · N». Без громоздких карточек.
  let turnPlan = null; // { body, head, badge, count }

  function ensureWorkGroup() {
    if (turnPlan) return turnPlan;
    const wrap = document.createElement("div");
    wrap.className = "work-wrap";
    const body = document.createElement("div");
    body.className = "work-group";
    wrap.appendChild(body);
    // Живая панель действий агента — над полем ввода. Новый запуск = новая панель
    // (предыдущая заменяется, чтобы не копились десятки блоков).
    const panel = $("work-panel");
    if (panel) {
      panel.innerHTML = "";
      panel.appendChild(wrap);
    } else {
      // Fallback (старый layout): как раньше, в конец ленты сообщений.
      $("messages").appendChild(wrap);
    }
    const head = document.createElement("div");
    head.className = "work-head";
    const dot = document.createElement("span");
    dot.className = "work-dot";
    const txt = document.createElement("span");
    txt.className = "work-title";
    txt.textContent = "Выполняю действия";
    const badge = document.createElement("span");
    badge.className = "work-count";
    badge.textContent = "0";
    const chev = document.createElement("span");
    chev.className = "work-chev";
    chev.textContent = "▾";
    head.appendChild(dot);
    head.appendChild(txt);
    head.appendChild(badge);
    head.appendChild(chev);
    head.title = "Показать/скрыть ход работ";
    head.onclick = (e) => {
      e.stopPropagation();
      // Сворачивается/разворачивается по клику и во время работы, и после.
      body.classList.toggle("expanded");
      updatePlanTitle(turnPlan);
    };
    body.appendChild(head);
    turnPlan = { body, head, txt, badge, count: 0 };
    return turnPlan;
  }

  function planAdd(ev) {
    const plan = ensureWorkGroup();
    plan.count += 1;
    plan.badge.textContent = String(plan.count);
    plan.label = (ev && TOOL_LABEL[ev.name]) || null;
    updatePlanTitle(plan);
  }

  function planSet() {
    // отдельного списка нет — строки действий обновляются в tool_result
  }

  function updatePlanTitle(plan) {
    const t = plan && plan.txt;
    if (!t) return;
    const done = plan.body.classList.contains("finished");
    const open = plan.body.classList.contains("expanded");
    if (done) t.textContent = "Действия выполнены";
    else if (!open && plan.label) t.textContent = "Выполняю: " + plan.label;
    else if (!open) t.textContent = "Выполняю действия";
    else t.textContent = "Выполняю действия";
  }


  function refreshMessage(m) {
    const old = msgEls.get(m.id);
    if (!old) return;
    const rebuilt = buildMessageEl(m);
    if (old.classList && old.classList.contains("in-work")) rebuilt.classList.add("in-work");
    old.parentNode.insertBefore(rebuilt, old);
    old.parentNode.removeChild(old);
    scrollBottom();
  }

  // Умная прокрутка: пока пользователь читает выше — не дёргаем вниз,
  // показываем плавающую кнопку «↓»; по клику/новому сообщению — обратно вниз.
  let pinnedToBottom = true;
  function scrollBottom() {
    const w = $("messages");
    if (!pinnedToBottom) return;
    w.scrollTop = w.scrollHeight;
  }
  function updatePinState() {
    const w = $("messages");
    const nearBottom = w.scrollHeight - w.scrollTop - w.clientHeight < 90;
    pinnedToBottom = nearBottom;
    $("btn-scroll-bottom").classList.toggle("hidden", nearBottom);
  }
  function jumpToBottom() {
    pinnedToBottom = true;
    $("btn-scroll-bottom").classList.add("hidden");
    const w = $("messages");
    w.scrollTop = w.scrollHeight;
  }

  // ─── Экономия кадров при стриме ───
  // Раньше КАЖДЫЙ чанк модели заменял innerHTML всего пузыря: на длинном ответе
  // браузер десятки раз в секунду пересобирал сотни узлов и заново растеризовал
  // «стеклянную» подложку — интерфейс начинал «жевать» при печати. Теперь текст
  // копится в данных, а DOM обновляется не чаще одного раза за кадр (финальный
  // рендер всё равно делает finishStream).
  let streamRenderRaf = 0;
  let streamDirty = [];
  function queueBubbleRender(chat, seg) {
    if (!seg) return;
    if (streamDirty.indexOf(seg.id) < 0) streamDirty.push(seg.id);
    if (streamRenderRaf) return;
    streamRenderRaf = requestAnimationFrame(() => {
      streamRenderRaf = 0;
      const ids = streamDirty;
      streamDirty = [];
      for (const id of ids) {
        const m = chat && chat.messages.find((x) => x.id === id);
        const el = msgEls.get(id);
        const b = el && el.querySelector ? el.querySelector(".bubble") : null;
        if (!m || !b) continue;
        b.classList.add("md");
        b.innerHTML = msgHtml(m.content);
      }
      scrollBottom();
    });
  }

  // Автопрокрутка — тоже не чаще кадра: scrollTop = scrollHeight заставляет браузер
  // синхронно пересчитать раскладку, и на каждый чанк это лишняя работа.
  let streamScrollRaf = 0;
  function scrollBottomSoon() {
    if (streamScrollRaf) return;
    streamScrollRaf = requestAnimationFrame(() => {
      streamScrollRaf = 0;
      scrollBottom();
    });
  }

  // ─────────────── Отправка ───────────────
  // Продолжить ответ, прерванный закрытием приложения. Идём тем же путём, что и
  // обычная отправка (в историю попадает прозрачная просьба дописать), поэтому
  // агент видит контекст и просто доводит задачу до конца.
  function continueInterruptedAnswer(chatId, m) {
    if (streaming) {
      toast("Дождись окончания текущего ответа");
      return;
    }
    const chat = chatsData.chats.find((c) => c.id === chatId);
    if (!chat) return;
    if (m) m.interrupted = false;
    if (chatsData.activeId !== chat.id) selectChat(chat.id);
    const input = $("input");
    input.value = "Продолжи предыдущий ответ с того места, где он прервался, и доведи задачу до конца. Не начинай заново и не повторяй уже сделанное.";
    autoResize();
    sendMessage();
  }

  async function sendMessage() {
    const input = $("input");
    const text = input.value.trim();
    if (!text || streaming) return;
    lastUndoCount = 0; // новый запуск — счётчик отката обнуляется
    if (planRotate(getActiveChat())) renderPlanPanel();
    if (!settings.model) {
      // У чипов-действий («Создать файл» и т.п.) не получается выполнить задачу
      // без модели — показываем понятное сообщение в настройках.
      openSettings();
      setSettingsMsg(
        "Сначала выбери модель: провайдер → API-ключ (для облака) → кнопка «Проверить подключение» → клик по модели из списка → «Сохранить настройки». Пока модель не выбрана, команды агенту («создай файл…») выполнить нельзя.",
        true
      );
      return;
    }
    let chat = getActiveChat();
    if (!chat) chat = createChat();
    if (chat.title === "Новый чат") chat.title = text.slice(0, 42) + (text.length > 42 ? "…" : "");

    const usePlan = planToggleOn;
    if (usePlan) {
      // Режим плана применяется к одному запросу, дальше выключается
      planToggleOn = false;
      $("btn-plan").classList.remove("active");
    }
    const content = pendingImage
      ? [{ type: "text", text }, { type: "image_url", image_url: { url: pendingImage } }]
      : text;
    chat.messages.push({ id: uid(), role: "user", content, createdAt: Date.now() });
    hideAttachBar();
    const assistantMsg = { id: uid(), role: "assistant", content: "", pending: true, createdAt: Date.now() };
    if (usePlan) assistantMsg.plan = true;
    chat.messages.push(assistantMsg);
    input.value = "";
    autoResize();
    renderSidebar();
    $("welcome").classList.add("hidden");
    $("messages").appendChild(buildMessageEl(chat.messages[chat.messages.length - 2]));
    $("messages").appendChild(buildMessageEl(assistantMsg));
    scrollBottom();
    persistChats();
    setStreaming(true);

    // Контекст-окно: держим историю в рамках бюджета токенов выбранной модели
    let history = chat.messages
      .filter((m) => m.role === "user" || (m.role === "assistant" && m.content))
      .map((m) => ({ role: m.role, content: m.content }));
    try {
      const budget = AgentCore.contextBudget(settings.provider || "openai", settings.model);
      history = AgentCore.trimConversation(history, budget);
    } catch {}

    session = { chatId: chat.id, assistantId: assistantMsg.id, segmentIds: [assistantMsg.id] };
    try {
      if (isElectron) {
        await api.sendMessage(history, { plan: usePlan });
      } else {
        webAbort = new AbortController();
        try {
          await webSend(history, onAiEvent, webAbort.signal, { plan: usePlan });
        } catch (e) {
          if (e.name !== "AbortError") onAiEvent({ type: "error", message: e.message || String(e) });
        }
      }
    } finally {
      finishStream(chat, assistantMsg);
      session = null;
      webAbort = null;
    }
  }

  // ─── Сегменты ответа: хронологический лог «текст → действия → текст → …» ───
  // Текст, пришедший сразу после действия (tool-сообщения), открывается НОВЫМ
  // сообщением ниже блока действий, а не дописывается в пузырь сверху.
  function ensureSegmentForText(chat, aMsg) {
    if (!chat) return aMsg || null;
    const msgs = chat.messages;
    const last = msgs[msgs.length - 1];
    const segIds = session && Array.isArray(session.segmentIds) ? session.segmentIds : null;
    if (last && last.role === "tool") {
      // Текст после действия — новый сегмент ответа в конец (ниже блока действий).
      const seg = { id: uid(), role: "assistant", content: "", pending: true, createdAt: Date.now() };
      msgs.push(seg);
      if (segIds) segIds.push(seg.id);
      planRoundStarted(chat, seg.id); // новый раунд работы закрывает шаг текстового плана
      $("messages").appendChild(buildMessageEl(seg));
      scrollBottom();
      return seg;
    }
    // Дописываем в последний сегмент текущего запуска, если он ещё последний.
    if (last && last.role === "assistant" && (!segIds || segIds.includes(last.id))) return last;
    return aMsg || null;
  }

  // Убрать пустой сегмент (промежуточный текст так и не появился) из данных и из DOM.
  function removeSegment(chat, s) {
    const idx = chat.messages.indexOf(s);
    if (idx >= 0) chat.messages.splice(idx, 1);
    const el = msgEls.get(s.id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    msgEls.delete(s.id);
    if (session && Array.isArray(session.segmentIds)) {
      const i = session.segmentIds.indexOf(s.id);
      if (i >= 0) session.segmentIds.splice(i, 1);
    }
    persistChatsSoon();
  }

  // Все assistant-сегменты текущего запуска (по порядку).
  function runSegments(chat, aMsg) {
    const ids = session && Array.isArray(session.segmentIds) ? session.segmentIds : null;
    if (!ids || !chat) return [aMsg].filter(Boolean);
    const segs = ids.map((id) => chat.messages.find((m) => m.id === id)).filter(Boolean);
    return segs.length ? segs : [aMsg].filter(Boolean);
  }

  function onAiEvent(ev) {
    const chat = session ? chatsData.chats.find((c) => c.id === session.chatId) : null;
    const aMsg = chat ? chat.messages.find((m) => m.id === session.assistantId) : null;
    switch (ev.type) {
      case "chunk": {
        const seg = ensureSegmentForText(chat, aMsg);
        if (seg) {
          seg.content += ev.text;
          persistChatsSoon();
          queueBubbleRender(chat, seg);
        }
        // План, написанный в ответе, показываем сразу, как только он сложился.
        tryPlanFromRunText(chat, aMsg);
        break;
      }
      case "thinking": {
        const seg = ensureSegmentForText(chat, aMsg);
        if (seg) {
          seg.thinking = (seg.thinking || "") + ev.text;
          persistChatsSoon();
          const el = msgEls.get(seg.id);
          if (el) {
            ensureThinkBox(el, seg.thinking);
            scrollBottomSoon();
          }
        }
        // План в размышлениях: локальные модели формулируют его именно там.
        tryPlanFromRunText(chat, aMsg);
        break;
      }
      case "plan": {
        // Модель вызвала todoWrite — показываем её план панелью-чеклистом.
        if (planFromModel(chat, ev)) {
          planCollapsed = false;
          renderPlanPanel();
          persistChatsSoon();
        }
        break;
      }
      case "tool_start":
        if (!chat) break;
        chat.messages.push({ id: uid(), role: "tool", toolName: ev.name, toolArgs: ev.args, toolResult: null, pending: true, createdAt: Date.now() });
        const toolEl = buildMessageEl(chat.messages[chat.messages.length - 1]);
        const work = ensureWorkGroup();
        if (toolEl && toolEl.classList) toolEl.classList.add("in-work");
        work.body.appendChild(toolEl);
        planAdd(ev);
        // Модель могла написать план текстом (или в размышлениях) вместо todoWrite —
        // разбираем его, чтобы панель-чеклист всё равно появилась.
        tryPlanFromRunText(chat, aMsg);
        // Работа пошла: текущий пункт текстового плана сразу становится «в работе»,
        // а не висит «ожидает» до конца раунда (иначе не видно, какой этап выполняется).
        if (
          chat &&
          chat.plan &&
          chat.plan.source === "text" &&
          Array.isArray(chat.plan.items) &&
          !chat.plan.items.some((i) => i.status === "in_progress")
        ) {
          if (planTextAdvance(chat, true)) renderPlanPanel();
        }
        scrollBottom();
        persistChatsSoon();
        break;
      case "tool_result":
        if (!chat) break;
        let toolOk = true;
        for (let i = chat.messages.length - 1; i >= 0; i--) {
          const m = chat.messages[i];
          if (m.role === "tool" && m.toolName === ev.name && m.pending) {
            toolOk = !/^(Ошибка|⚠|Ошибка git|Ошибка:)/.test(ev.result || "");
            m.pending = false;
            m.toolResult = ev.result;
            m.toolOk = toolOk;
            refreshMessage(m);
            break;
          }
        }
        if (planToolOutcome(chat, ev, toolOk)) renderPlanPanel();
        planSet(ev, toolOk);
        persistChatsSoon();
        // Агент изменил файлы или git — обновляем панель проекта
        if (["writeFile", "editFile", "runCommand", "createFolder", "gitClone", "gitCommit", "gitRevert", "gitPush", "gitPull"].includes(ev.name)) {
          if (!$("project-panel").classList.contains("hidden")) setTimeout(refreshProject, 400);
        }
        break;
      case "text_override": {
        const seg = ensureSegmentForText(chat, aMsg);
        if (seg) {
          seg.content = ev.text;
          persistChatsSoon();
          queueBubbleRender(chat, seg);
        }
        break;
      }
      case "ask": {
        // Агент задал вопрос (askUser) — показываем модалку и ждём ответа
        openAskModal(ev.question || "Уточни, пожалуйста", (t) => {
          if (isElectron && api.answerQuestion) api.answerQuestion(t);
        });
        break;
      }
      case "vision": {
        if (ev.text) {
          const note = document.createElement("div");
          note.className = "vision-note";
          note.textContent = ev.text;
          $("messages").appendChild(note);
          scrollBottom();
        }
        break;
      }
      case "context": {
        renderContext(ev);
        break;
      }
      case "memory": {
        // Памятка контекста сохранена в локальный дневник (память диалогов) — плашка
        if (ev.text) {
          const mnote = document.createElement("div");
          mnote.className = "vision-note";
          mnote.textContent = ev.text;
          $("messages").appendChild(mnote);
          scrollBottom();
        }
        break;
      }
      case "compact": {
        // Контекст сжат в памятку (экономия токенов) — показываем плашку
        if (ev.text) {
          const note = document.createElement("div");
          note.className = "vision-note";
          note.textContent = ev.text;
          $("messages").appendChild(note);
          scrollBottom();
        }
        break;
      }
      case "image":
        showImageOverlay(ev.path || "", ev.dataUrl || "");
        break;
      case "diff":
        showPatchOverlay((ev.a || "") + "  ↔  " + (ev.b || ""), ev.patch || "");
        break;
      case "preview":
        // инструмент previewUI открывает постоянную правую панель (как в Replit),
        // а не разовый оверлей
        openSidePanel("preview");
        previewOpen(ev.url || "");
        break;
      case "undo_available": {
        lastUndoCount = ev.count || 0;
        break;
      }
      case "checkpoint": {
        // Авто-чекпоинт: агент закончил задачу и создал локальный коммит
        if (ev.message) toast(ev.message);
        break;
      }
      case "retry": {
        // Авто-повтор после сбоя: агент упал и продолжает с сохранённым контекстом
        const rErr = String(ev.error || "").slice(0, 200);
        toast("🔄 Попытка " + (ev.attempt || 2) + " из " + (ev.total || 3) + " после сбоя" + (rErr ? ": " + rErr : ""));
        break;
      }
      case "profile_switched": {
        // Авто-переключение между сохранёнными подключениями при ошибке ключа/баланса/лимита
        const pName = ev.name || "?";
        const pErr = String(ev.error || "").slice(0, 160);
        const ch = session ? chatsData.chats.find((c) => c.id === session.chatId) : null;
        if (ch) {
          ch.messages.push({
            id: uid(),
            role: "system",
            content: "🔄 Запрос упал" + (pErr ? ": " + pErr : "") + ".\nАвтоматически переключено на подключение «" + pName + "» — повторяю запрос с новым ключом.",
            createdAt: Date.now(),
          });
          const el = buildMessageEl(ch.messages[ch.messages.length - 1]);
          const w = ensureWorkGroup();
          w.body.appendChild(el);
          scrollBottom();
          persistChatsSoon();
        }
        // Синхронизируем локальную копию настроек с main (активный профиль сменился)
        settings.openaiActiveProfile = ev.id || settings.openaiActiveProfile;
        if (isElectron) api.getSettings().then((s) => { if (s) settings = normalize(s); });
        toast("🔄 Переключено на подключение «" + pName + "»");
        break;
      }
      case "done":
        // План, написанный моделью текстом (или в размышлениях), разбираем и на финише,
        // а его текущий пункт закрываем: запуск завершён.
        tryPlanFromRunText(chat, aMsg);
        if (planTextFinish(chat)) {
          renderPlanPanel();
          persistChatsSoon();
        }
        // После завершения запуска обновляем панель git: авто-коммит мог очистить «Изменения»
        setTimeout(() => {
          if (!$("project-panel").classList.contains("hidden")) refreshProject();
        }, 300);
        break;
      case "error": {
        closeAskModal();
        const segs = runSegments(chat, aMsg);
        for (const s of segs) s.pending = false;
        const lastSeg = segs[segs.length - 1] || aMsg;
        if (lastSeg) {
          lastSeg.error = ev.message;
          refreshMessage(lastSeg);
        }
        break;
      }
      case "yc_step": {
        const box = $("yc-deploy-box");
        const stepsEl = $("yc-deploy-steps");
        if (box && !box.classList.contains("hidden") && stepsEl) {
          const loading = stepsEl.querySelector(".yc-loading");
          if (loading) loading.remove();
          const d = document.createElement("div");
          d.className = "yc-step";
          d.textContent = ev.text || "";
          stepsEl.appendChild(d);
          const sp = $("sp-cloud");
          if (sp) sp.scrollTop = sp.scrollHeight;
        }
        break;
      }
    }
  }

  // Показ изображения, присланного инструментом showImage / screenshotCapture (событие image)
  function showImageOverlay(filePath, dataUrl) {
    const overlay = $("file-overlay");
    $("file-path").textContent = filePath || "Изображение";
    fileViewPath = "";
    $("btn-file-edit").classList.add("hidden");
    $("btn-file-save").classList.add("hidden");
    $("btn-file-delete").classList.add("hidden");
    const content = $("file-content");
    content.innerHTML = "";
    const img = document.createElement("img");
    img.className = "image-view";
    img.src = dataUrl || "";
    img.alt = filePath || "изображение";
    content.appendChild(img);
    overlay.classList.remove("hidden");
  }

  // Визуальный дифф двух файлов (инструмент diffView, событие diff)
  function showPatchOverlay(title, patch) {
    const overlay = $("file-overlay");
    $("file-path").textContent = title || "Сравнение файлов";
    fileViewPath = "";
    $("btn-file-edit").classList.add("hidden");
    $("btn-file-save").classList.add("hidden");
    $("btn-file-delete").classList.add("hidden");
    const content = $("file-content");
    content.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "code-view";
    for (const ln of String(patch || "").split("\n")) {
      const line = document.createElement("div");
      let cls = "";
      if (/^(@@|diff --git|index |--- |\+\+\+ )/.test(ln)) cls = "meta";
      else if (/^\+/.test(ln)) cls = "add";
      else if (/^-/.test(ln)) cls = "del";
      line.className = "diff-line" + (cls ? " " + cls : "");
      line.textContent = ln || " ";
      pre.appendChild(line);
    }
    content.appendChild(pre);
    overlay.classList.remove("hidden");
  }

  // Встроенный предпросмотр сайта (инструмент previewUI, событие preview)
  function showPreviewOverlay(url) {
    const overlay = $("file-overlay");
    $("file-path").textContent = "Предпросмотр: " + url;
    fileViewPath = "";
    $("btn-file-edit").classList.add("hidden");
    $("btn-file-save").classList.add("hidden");
    $("btn-file-delete").classList.add("hidden");
    const content = $("file-content");
    content.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.src = url;
    content.appendChild(frame);
    overlay.classList.remove("hidden");
  }

  // ─────────────── Правая панель: превью + консоль (как в Replit) ───────────────
  let sideTab = "preview"; // активная вкладка правой панели
  let termBuf = []; // буфер вывода консоли (рендерится в <pre>)
  let termHist = []; // история команд консоли
  let termHistIdx = -1;
  let termAutostartDone = false;
  let previewLoaded = ""; // последний загруженный URL превью

  function sidePanelVisible() {
    return !$("side-panel").classList.contains("hidden");
  }

  function openSidePanel(tab) {
    sideTab = tab || sideTab;
    $("side-panel").classList.remove("hidden");
    for (const b of document.querySelectorAll(".sp-btn")) {
      b.classList.toggle("active", b.dataset.sp === sideTab);
    }
    $("sp-console").classList.toggle("hidden", sideTab !== "console");
    $("sp-preview").classList.toggle("hidden", sideTab !== "preview");
    const spCloudEl = $("sp-cloud");
    if (spCloudEl) spCloudEl.classList.toggle("hidden", sideTab !== "cloud");
    $("btn-toggle-console").classList.add("active");
    $("btn-toggle-preview").classList.add("active");
    if ($("btn-toggle-cloud")) $("btn-toggle-cloud").classList.add("active");
    if (sideTab === "console") {
      ensureTerminal();
      setTimeout(() => $("term-input").focus(), 50);
    }
    if (sideTab === "preview") {
      refreshDevControls();
      if (!previewLoaded && settings.previewUrl) previewOpen(settings.previewUrl);
    }
    if (sideTab === "cloud") {
      ycLoadDashboard(false);
    }
  }

  function closeSidePanel() {
    $("side-panel").classList.add("hidden");
    $("btn-toggle-console").classList.remove("active");
    $("btn-toggle-preview").classList.remove("active");
    if ($("btn-toggle-cloud")) $("btn-toggle-cloud").classList.remove("active");
  }

  function switchSideTab(tab) {
    openSidePanel(tab);
  }

  // ── Консоль ──
  function termAppend(html) {
    const out = $("term-out");
    const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
    termBuf.push(html);
    if (termBuf.length > 3000) termBuf.splice(0, termBuf.length - 3000);
    out.innerHTML = termBuf.join("");
    if (nearBottom) out.scrollTop = out.scrollHeight;
  }

  function termReset() {
    termBuf = [];
    $("term-out").innerHTML = '<div class="term-welcome">Консоль рабочей директории. Логи сервера и вывод команд — здесь. Введи команду ниже (например: ls, npm run dev, bun test).</div>';
  }

  function ensureTerminal() {
    if (!isElectron) return;
    if (termAutostartDone) return;
    termAutostartDone = true;
    api.termStatus().then((st) => {
      if (!st || !st.running) api.termStart().then((r) => {
        if (!r || !r.ok) toast("Консоль: " + ((r && r.error) || "не удалось запустить"));
      });
    });
  }

  function termSend() {
    if (!isElectron) return;
    const inp = $("term-input");
    const text = inp.value.trim();
    if (!text) return;
    termHist.push(text);
    termHistIdx = -1;
    inp.value = "";
    api.termInput(text);
  }

  function onTermEvent(ev) {
    if (!ev) return;
    if (ev.type === "metrics") {
      // Метрики раунда агента из main.js: сколько токенов ушло, попал ли префикс в
      // кэш, сколько ждали ответа. Тихой строкой в «Консоль» (правая панель).
      termServerAppend('<span class="ts-metrics">▤ ' + esc(ev.text || "") + "</span>");
    } else if (ev.type === "out") {
      const escTxt = esc(ev.text || "");
      termAppend('<span class="term-plain">' + escTxt + "</span>");
    } else if (ev.type === "agent") {
      const escTxt = esc(ev.text || "").replace(/\n/g, "<br>");
      termAppend('<div class="term-agent">' + escTxt + "</div>");
    } else if (ev.type === "in") {
      const cmd = esc(ev.text || "");
      termAppend('<div class="term-cmd-line"><span class="term-prefix">❯</span> <span class="term-cmd">' + cmd + "</span></div>");
    } else if (ev.type === "start") {
      const cwd = esc(ev.cwd || "");
      termAppend('<div class="term-exit">— терминал запущен' + (cwd ? " в " + cwd : "") + " —</div>");
      $("btn-term-stop").classList.remove("hidden");
    } else if (ev.type === "exit") {
      termAppend('<div class="term-exit">— процесс завершён (код ' + esc(String(ev.code ?? "?")) + (ev.error ? ", " + esc(ev.error) : "") + ") —</div>");
      $("btn-term-stop").classList.add("hidden");
      termAutostartDone = false; // панель можно перезапустить заново
    }
  }

  // ── Превью ──
  function previewOpen(url) {
    const u = String(url || "").trim();
    if (!u) return;
    previewLoaded = u;
    settings.previewUrl = u;
    persistSettings();
    // С телефона localhost — это сам телефон; подставляем адрес ПК (мост).
    const shown = window.mobileApi && window.mobileApi.host
      ? u.replace(/^https?:\/\/localhost(:\d+)?/i, "http://" + window.mobileApi.host)
      : u;
    $("preview-url").value = shown;
    $("preview-frame").src = shown;
  }

  function previewSetDevice(w) {
    const dev = $("preview-device");
    dev.style.width = w === "100%" ? "100%" : w + "px";
    dev.classList.toggle("phone", w === "390");
    dev.classList.toggle("tablet", w === "768");
    for (const b of document.querySelectorAll(".dev-btns .dev")) {
      b.classList.toggle("active", b.dataset.w === w);
    }
  }

  function previewOpenTab() {
    const u = $("preview-url").value.trim();
    if (!u) return;
    if (isElectron && api.openExternal && !window.mobileApi) api.openExternal(u);
    else window.open(u, "_blank");
  }

  // ── Быстрый запуск проекта в превью: старт/стоп dev-сервера, освобождение порта ──
  let previewLogLines = [];
  let previewRunning = false;

  function previewLogAppend(html) {
    previewLogLines.push(html);
    if (previewLogLines.length > 500) previewLogLines.splice(0, previewLogLines.length - 500);
    const log = $("preview-log");
    const wrap = $("preview-log-wrap");
    if (log) {
      log.innerHTML = previewLogLines.join("");
      wrap.classList.remove("hidden");
      wrap.scrollTop = wrap.scrollHeight;
    }
  }

  function setPreviewStatus(running, err) {
    previewRunning = !!running;
    $("btn-preview-start").classList.toggle("hidden", running);
    $("btn-preview-stop").classList.toggle("hidden", !running);
    const st = $("preview-status");
    if (!st) return;
    const dot = st.querySelector(".ps-dot");
    const txt = st.querySelector("span");
    if (dot) dot.className = "ps-dot" + (running ? " on" : err ? " err" : " off");
    if (txt) txt.textContent = running ? "Запущен" : err ? "Ошибка" : "Остановлено";
    updateStatusBar();
  }

  function refreshDevControls() {
    if (!isElectron || !api.devStatus) return;
    api.devStatus(projectDir()).then((st) => {
      if (!st || !st.ok) return;
      const cmdInp = $("preview-cmd");
      if (cmdInp) {
        if (st.command && !cmdInp.value.trim()) cmdInp.value = st.command;
        if (!st.command && !cmdInp.value.trim() && st.detected) {
          cmdInp.value = st.detected;
          cmdInp.placeholder = st.detected;
        }
      }
      setPreviewStatus(st.running, false);
    });
  }

  async function devStartClick() {
    if (!isElectron || !api.devStart) return;
    if (previewRunning) return; // уже запускаем/запущен
    const cmd = $("preview-cmd").value.trim();
    setPreviewStatus(true, false);
    previewLogAppend('<div class="pl-cmd">▶ ' + esc(cmd || "…") + "</div>");
    const r = await api.devStart(projectDir(), cmd);
    if (!r || !r.ok) {
      setPreviewStatus(false, true);
      previewLogAppend('<div class="pl-err">✕ ' + esc((r && r.error) || "Не удалось запустить") + "</div>");
      toast((r && r.error) || "Не удалось запустить проект");
      return;
    }
    toast("Проект запущен: " + r.command);
    // Сразу открываем превью на настроенном адресе (по умолчанию http://localhost:5000).
    previewOpen(settings.previewUrl || "http://localhost:5000");
    refreshDevControls();
  }

  async function devStopClick() {
    if (!isElectron || !api.devStop) return;
    await api.devStop();
    previewLogAppend('<div class="pl-exit">⏹ процесс остановлен, порт освобождён</div>');
    setPreviewStatus(false, false);
    refreshDevControls();
  }

  // Логи запущенного сервера дублируются в консоль (вкладка «Консоль»)
  function termServerAppend(html) {
    termAppend('<div class="term-server">' + html + "</div>");
  }

  function onDevEvent(ev) {
    if (!ev) return;
    if (ev.type === "start") {
      previewLogAppend('<div class="pl-exit">— запуск: ' + esc(ev.command || "") + " в " + esc(ev.cwd || "") + " —</div>");
      termServerAppend('<span class="ts-info">— сервер запущен: ' + esc(ev.command || "") + " в " + esc(ev.cwd || "") + " —</span>");
      setPreviewStatus(true, false);
    } else if (ev.type === "out") {
      previewLogAppend("<span>" + esc(ev.text || "") + "</span>");
      termServerAppend("<span>" + esc(ev.text || "") + "</span>");
    } else if (ev.type === "exit") {
      const tail =
        "— сервер завершён (код " +
        esc(String(ev.code ?? "?")) +
        (ev.error ? ", " + esc(ev.error) : "") +
        ") —";
      previewLogAppend('<div class="pl-exit">' + tail + "</div>");
      termServerAppend('<span class="ts-err">' + tail + "</span>");
      setPreviewStatus(false, !!(ev.error || (ev.code != null && ev.code !== 0)));
    } else if (ev.type === "stopped") {
      previewLogAppend('<div class="pl-exit">— остановлено пользователем —</div>');
      termServerAppend('<span class="ts-info">— сервер остановлен —</span>');
      setPreviewStatus(false, false);
    }
  }

  // Tab-дополнение команды в терминале: один вариант — дополняем, несколько — показываем список
  function termTabComplete() {
    if (!isElectron || !api.termComplete) return;
    const inp = $("term-input");
    const line = inp.value;
    api.termComplete(line).then((r) => {
      if (!r) return;
      const matches = r.matches || [];
      if (matches.length === 1) {
        inp.value = (r.base || "") + matches[0];
      } else if (matches.length > 1) {
        termAppend('<div class="term-exit">' + matches.slice(0, 12).map((m) => esc(m)).join("  ") + (matches.length > 12 ? "  …" : "") + "</div>");
      }
    });
  }

  // ─────────────── Удобство: копирование, регенерация, редактирование ───────────────
  function copyText(text) {
    const done = () => toast("Скопировано в буфер обмена");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
      done();
    }
  }

  // «↻ Перегенерировать» показываем только у последнего ответа агента
  function isLastAssistant(m) {
    const chat = getActiveChat();
    if (!chat) return false;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role !== "tool") return chat.messages[i] === m;
    }
    return false;
  }

  function regenerate(m) {
    if (streaming) return;
    const chat = getActiveChat();
    if (!chat) return;
    const idx = chat.messages.indexOf(m);
    if (idx <= 0) return;
    // Ответ агента может состоять из нескольких сегментов текста и действий —
    // убираем весь запуск: от последнего user-сообщения до конца.
    let start = idx;
    for (let i = idx - 1; i >= 0; i--) {
      if (chat.messages[i].role === "user") {
        start = i + 1;
        break;
      }
    }
    chat.messages.splice(start);
    persistChats();
    renderMessages();
    const lastUser = [...chat.messages].reverse().find((x) => x.role === "user");
    if (lastUser) {
      const inp = $("input");
      inp.value = lastUser.content;
      autoResize();
      sendMessage();
    }
  }

  function editUserMessage(m) {
    if (streaming) return;
    const chat = getActiveChat();
    if (!chat) return;
    const idx = chat.messages.indexOf(m);
    if (idx < 0) return;
    const inp = $("input");
    inp.value = msgText(m.content);
    autoResize();
    inp.focus();
    chat.messages.splice(idx); // удалить это сообщение и всё после — текст уже в поле ввода
    persistChats();
    renderMessages();
  }

  // Скопировать активный чат в буфер обмена в виде markdown
  function copyChat() {
    const chat = getActiveChat();
    if (!chat || !chat.messages.length) {
      toast("Чат пуст");
      return;
    }
    const lines = ["# " + chatTitle(chat), ""];
    for (const m of chat.messages) {
      if (m.role === "user") {
        lines.push("**Пользователь:**", "", m.content || "", "");
      } else if (m.role === "assistant") {
        lines.push("**Ассистент:**", "", m.content || "", "");
      } else if (m.role === "tool") {
        lines.push("**Инструмент:** " + (m.toolName || ""), "", "```", m.toolResult || "", "```", "");
      }
    }
    copyText(lines.join("\n"));
  }

  // ─────────────── Быстрое переключение модели (попап в шапке) ───────────────
  function toggleModelPopup() {
    const popup = $("model-popup");
    const willShow = popup.classList.contains("hidden");
    popup.classList.toggle("hidden", !willShow);
    if (willShow) renderModelPopup();
  }
  function closeModelPopup() {
    $("model-popup").classList.add("hidden");
  }
  function renderModelPopup() {
    const provider = settings.provider || "openai";
    const cur = settings.model || "";
    $("mp-title").textContent = "Модель · " + (PRESET_LABEL[provider] || provider);
    const list = $("mp-list");
    list.innerHTML = "";
    const models = cachedModels[provider] || [];
    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = "Список моделей ещё не загружен. Нажми «↻ Обновить» или открой Настройки.";
      list.appendChild(empty);
    }
    for (const name of models.slice(0, 30)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mp-item" + (name === cur ? " active" : "");
      b.textContent = name;
      b.title = "Выбрать модель " + name;
      b.onclick = () => selectModelQuick(provider, name);
      list.appendChild(b);
    }
  }
  function selectModelQuick(provider, name) {
    settings.model = name;
    settings[MODEL_KEY[provider]] = name;
    const input = $(MODEL_INPUT[provider]);
    if (input) input.value = name;
    persistSettings();
    updateBadge();
    closeModelPopup();
    toast("Модель: " + name);
  }
  async function refreshModelsQuick() {
    const provider = settings.provider || "openai";
    const btn = $("mp-refresh");
    btn.disabled = true;
    btn.textContent = "Загружаю...";
    try {
      const cfg = { ...settings, provider, model: "" };
      const res = isElectron ? await api.listModels(cfg) : await AgentCore.listModels(cfg, { fromBrowser: true });
      const models = res && res.ok ? res.models : null;
      if (Array.isArray(models)) {
        cachedModels[provider] = models;
        renderModelPopup();
        toast("Моделей: " + models.length);
      } else {
        toast("Ошибка: " + ((res && res.message) || (res && res.error) || "не удалось загрузить"));
      }
    } catch (e) {
      toast("Ошибка: " + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = "↻ Обновить";
    }
  }

  // Переименование чата: двойной клик по заголовку → инлайн-ввод
  function startRenameChat() {
    const chat = getActiveChat();
    if (!chat || streaming) return;
    const titleEl = $("chat-title");
    const old = chatTitle(chat);
    const inp = document.createElement("input");
    inp.id = "chat-title-input";
    inp.className = "chat-title-input";
    inp.value = old;
    inp.maxLength = 80;
    inp.spellcheck = false;
    titleEl.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const val = save ? inp.value.trim() : old;
      if (save && val && val !== old) {
        chat.title = val;
        persistChats();
        renderSidebar();
        toast("Чат переименован");
      }
      const div = document.createElement("div");
      div.id = "chat-title";
      div.textContent = chatTitle(chat);
      inp.replaceWith(div);
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    inp.addEventListener("blur", () => finish(true));
  }

  // ─────────────── Пароли сайтов (Настройки → Секреты) ───────────────
  // Записи живут в settings.sitePasswords и уходят в main.js вместе с настройками —
  // там они шифруются (secrets.json + safeStorage/DPAPI). В интерфейсе пароль
  // никогда не показывается: только пометка «пароль: ••••••«.
  function vaultArr() {
    return Array.isArray(settings.sitePasswords) ? settings.sitePasswords : [];
  }

  let vaultEditingId = ""; // id записи, которую правим (пусто — добавляем новую)

  function renderVault() {
    const box = $("vault-list");
    if (!box) return;
    const list = vaultArr();
    box.innerHTML = "";
    if (!list.length) {
      box.innerHTML =
        '<div class="env-note">Записей пока нет. Добавь сайт ниже — агент сможет входить на него сам (vaultFill), не спрашивая пароль в чате.</div>';
      return;
    }
    for (const e of list) {
      if (!e || typeof e !== "object") continue;
      const row = document.createElement("div");
      row.className = "env-row";
      const name = document.createElement("span");
      name.className = "env-key";
      name.textContent = e.name || e.url || "Сайт";
      name.title = e.name || "";
      const val = document.createElement("span");
      val.className = "env-val";
      const bits = [];
      if (e.url) bits.push(e.url);
      bits.push(e.login ? "логин: " + e.login : "логин не задан");
      bits.push(e.password ? "пароль: ••••••" : "пароль не задан");
      if (e.note) bits.push("📝 " + e.note);
      val.textContent = bits.join(" · ");
      val.title = e.note ? "Заметка: " + e.note : "";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn btn-ghost btn-small";
      edit.textContent = "✏️";
      edit.title = "Загрузить запись в форму для правки";
      edit.onclick = () => vaultLoadToForm(e);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-small env-del";
      del.textContent = "🗑";
      del.title = "Удалить запись " + (e.name || e.url || "");
      del.onclick = () => vaultDelete(e.id);
      row.appendChild(name);
      row.appendChild(val);
      row.appendChild(edit);
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  function vaultLoadToForm(e) {
    vaultEditingId = e.id || "";
    $("s-vault-name").value = e.name || "";
    $("s-vault-url").value = e.url || "";
    $("s-vault-login").value = e.login || "";
    $("s-vault-pass").value = "";
    $("s-vault-note").value = e.note || "";
    toast("Запись загружена. Пароль введи заново — в форме он не показывается.");
  }

  function vaultClearForm() {
    vaultEditingId = "";
    for (const id of ["s-vault-name", "s-vault-url", "s-vault-login", "s-vault-pass", "s-vault-note"]) {
      if ($(id)) $(id).value = "";
    }
  }

  function vaultAdd() {
    const entry = {
      id: vaultEditingId || "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: $("s-vault-name").value.trim(),
      url: $("s-vault-url").value.trim(),
      login: $("s-vault-login").value.trim(),
      password: $("s-vault-pass").value,
      note: $("s-vault-note").value.trim(),
    };
    if (!entry.name && !entry.url) {
      toast("Укажи название или адрес сайта");
      return;
    }
    if (!entry.login && !entry.password) {
      toast("Заполни хотя бы логин или пароль");
      return;
    }
    if (!Array.isArray(settings.sitePasswords)) settings.sitePasswords = [];
    const i = settings.sitePasswords.findIndex((x) => x && x.id === entry.id);
    if (i >= 0) settings.sitePasswords[i] = entry;
    else settings.sitePasswords.push(entry);
    persistSettings();
    vaultClearForm();
    renderVault();
    toast(i >= 0 ? "Запись обновлена" : "Запись сохранена зашифрованно");
  }

  function vaultDelete(id) {
    const list = vaultArr();
    const e = list.find((x) => x && x.id === id);
    if (!e) return;
    if (!confirm("Удалить запись «" + (e.name || e.url || "сайт") + "»?")) return;
    settings.sitePasswords = list.filter((x) => x && x.id !== id);
    persistSettings();
    renderVault();
    toast("Запись удалена");
  }

  // ─────────────── Почта (Настройки → ✉️ Почта) ───────────────
  function renderMailStatus(text, isError) {
    const box = $("mail-msg");
    if (!box) return;
    box.textContent = text || "";
    box.classList.toggle("error", !!isError);
  }

  // Пресеты провайдеров (та же логика, что в src/mail.js) — чтобы кнопка
  // «Определить по адресу» работала и без запроса к main-процессу.
  function mailGuessed() {
    const a = String($("s-mail-address") ? $("s-mail-address").value : "").trim().toLowerCase();
    if (/@(gmail|googlemail)\.com$/.test(a)) return { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465, starttls: false, note: "Gmail: нужен «пароль приложения» (включается при двухфакторной аутентификации)." };
    if (/@(yandex|ya)\.(ru|com|kz|by|ua)$/.test(a)) return { imapHost: "imap.yandex.ru", imapPort: 993, smtpHost: "smtp.yandex.ru", smtpPort: 465, starttls: false, note: "Яндекс: включи IMAP в «Все настройки → Почтовые программы» и создай пароль приложения." };
    if (/@mail\.ru$/.test(a)) return { imapHost: "imap.mail.ru", imapPort: 993, smtpHost: "smtp.mail.ru", smtpPort: 465, starttls: false, note: "Mail.ru: нужен пароль для внешнего приложения." };
    if (/@(outlook|hotmail|live|msn)\./.test(a)) return { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587, starttls: true, note: "Outlook: SMTP через STARTTLS (587)." };
    if (/@rambler\.ru$/.test(a)) return { imapHost: "imap.rambler.ru", imapPort: 993, smtpHost: "smtp.rambler.ru", smtpPort: 465, starttls: false, note: "" };
    const d = a.includes("@") ? a.split("@").pop() : "";
    return {
      imapHost: d ? "imap." + d : "",
      imapPort: 993,
      smtpHost: d ? "smtp." + d : "",
      smtpPort: 465,
      starttls: false,
      note: d ? "Провайдер не опознан — проверь адреса серверов и порты." : "",
    };
  }

  function mailFillServers() {
    const g = mailGuessed();
    if (g.imapHost) $("s-mail-imap-host").value = g.imapHost;
    if (g.imapPort) $("s-mail-imap-port").value = String(g.imapPort);
    if (g.smtpHost) $("s-mail-smtp-host").value = g.smtpHost;
    if (g.smtpPort) $("s-mail-smtp-port").value = String(g.smtpPort);
    $("s-mail-starttls").checked = !!g.starttls;
    renderMailStatus(g.note || "Серверы заполнены — проверь и нажми «Сохранить настройки».", false);
  }

  function mailRenderList(res) {
    const box = $("mail-list");
    if (!box) return;
    box.innerHTML = "";
    if (!res || !res.ok) { renderMailStatus((res && res.error) || "Не удалось прочитать почту.", true); return; }
    if (!res.messages || !res.messages.length) { renderMailStatus("Входящих писем нет.", false); return; }
    for (const m of res.messages) {
      const row = document.createElement("div");
      row.className = "env-row";
      const subj = document.createElement("div");
      subj.className = "env-key";
      subj.textContent = (m.code ? "🔑 " + m.code + " · " : "") + (m.subject || "(без темы)");
      const meta = document.createElement("div");
      meta.className = "env-val";
      meta.textContent = (m.from || "") + " · " + (m.date || "");
      row.appendChild(subj);
      row.appendChild(meta);
      box.appendChild(row);
    }
    renderMailStatus("Последние письма: " + res.messages.length + " из " + (res.total || res.messages.length) + ".", false);
  }

  async function mailDoTest() {
    if (!isElectron) { renderMailStatus("Проверка почты доступна в desktop-приложении.", true); return; }
    renderMailStatus("Проверяю вход в ящик…", false);
    try {
      const r = await api.mailTest();
      if (r && r.ok) {
        const s = r.servers || {};
        renderMailStatus(
          "✓ Вход выполнен. Писем в ящике: " + (r.total || 0) +
          " · IMAP " + (s.imapHost || "") + ":" + (s.imapPort || "") +
          " · SMTP " + (s.smtpHost || "") + ":" + (s.smtpPort || ""),
          false
        );
      } else {
        const note = r && r.servers && r.servers.note ? "\n" + r.servers.note : "";
        renderMailStatus("✗ " + ((r && r.error) || "Не удалось войти.") + note, true);
      }
    } catch (e) {
      renderMailStatus("✗ Ошибка: " + ((e && e.message) || e), true);
    }
  }

  async function mailDoTestSend() {
    if (!isElectron) { renderMailStatus("Отправка доступна в desktop-приложении.", true); return; }
    renderMailStatus("Отправляю тестовое письмо…", false);
    try {
      const r = await api.mailTestSend();
      const addr = $("s-mail-address") ? $("s-mail-address").value.trim() : "";
      renderMailStatus(r && r.ok ? "✓ Тестовое письмо отправлено на " + addr + ". Проверь входящие." : "✗ " + ((r && r.error) || "Не удалось отправить."), !(r && r.ok));
    } catch (e) {
      renderMailStatus("✗ Ошибка: " + ((e && e.message) || e), true);
    }
  }

  async function mailDoRecent() {
    if (!isElectron) { renderMailStatus("Чтение почты доступно в desktop-приложении.", true); return; }
    renderMailStatus("Читаю последние письма…", false);
    try {
      mailRenderList(await api.mailRecent(5));
    } catch (e) {
      renderMailStatus("✗ Ошибка: " + ((e && e.message) || e), true);
    }
  }


  // ─────────────── Секреты: переменные окружения (Настройки) ───────────────
  function renderEnvVars() {
    const box = $("env-list");
    if (!box) return;
    const vars = settings.agentEnv || {};
    const keys = Object.keys(vars);
    box.innerHTML = "";
    if (!keys.length) {
      box.innerHTML = '<div class="env-note">Переменных пока нет. Добавь вручную ниже или импортируй из файла .env.</div>';
      return;
    }
    for (const k of keys) {
      const v = String(vars[k] || "");
      const row = document.createElement("div");
      row.className = "env-row";
      const kEl = document.createElement("span");
      kEl.className = "env-key";
      kEl.textContent = k;
      kEl.title = k;
      const vEl = document.createElement("span");
      vEl.className = "env-val";
      vEl.textContent = v ? "•••••••• (" + v.length + " симв.)" : "(пусто)";
      vEl.title = v ? "Значение скрыто — оно подставляется в команды автоматически" : "";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-small env-del";
      del.textContent = "🗑";
      del.title = "Удалить " + k;
      del.onclick = () => envDelete(k);
      row.appendChild(kEl);
      row.appendChild(vEl);
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  function envAdd() {
    const k = $("s-env-key").value.trim();
    const v = $("s-env-value").value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      toast("Имя переменной: латиница, цифры, подчёркивание (например DATABASE_URL)");
      return;
    }
    if (!settings.agentEnv) settings.agentEnv = {};
    settings.agentEnv[k] = v;
    persistSettings();
    $("s-env-key").value = "";
    $("s-env-value").value = "";
    renderEnvVars();
    toast("Переменная " + k + " сохранена");
  }

  function envDelete(k) {
    if (!settings.agentEnv || !(k in settings.agentEnv)) return;
    delete settings.agentEnv[k];
    persistSettings();
    renderEnvVars();
    toast("Удалено: " + k);
  }

  // Парсит .env-текст: строки KEY=VALUE, комментарии # и ;, префикс export, кавычки значения.
  function parseEnvText(text) {
    const vars = {};
    for (const rawLine of String(text || "").split(/\r?\n/)) {
      let line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      if (line.startsWith("export ")) line = line.slice(7).trim();
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    return vars;
  }

  function envImportText() {
    const text = $("s-env-import").value;
    if (!text.trim()) {
      toast("Вставь список строк вида KEY=VALUE");
      return;
    }
    const vars = parseEnvText(text);
    const keys = Object.keys(vars);
    if (!keys.length) {
      toast("Не нашёл строк вида KEY=VALUE");
      return;
    }
    if (!settings.agentEnv) settings.agentEnv = {};
    for (const k of keys) settings.agentEnv[k] = vars[k];
    persistSettings();
    $("s-env-import").value = "";
    renderEnvVars();
    toast("Импортировано переменных: " + keys.length);
  }

  function envImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const vars = parseEnvText(String(reader.result || ""));
      const keys = Object.keys(vars);
      if (!settings.agentEnv) settings.agentEnv = {};
      for (const k of keys) settings.agentEnv[k] = vars[k];
      persistSettings();
      renderEnvVars();
      toast(keys.length ? "Импортировано из файла: " + keys.length + " переменных" : "В файле нет строк вида KEY=VALUE");
    };
    reader.readAsText(file);
  }

  // ── Модалка «вопрос агента» (askUser) ──
  let askOnAnswer = null;
  function openAskModal(question, onAnswer) {
    $("ask-question").textContent = question;
    $("ask-input").value = "";
    $("ask-overlay").classList.remove("hidden");
    setTimeout(() => $("ask-input").focus(), 60);
    askOnAnswer = onAnswer;
  }
  function closeAskModal() {
    $("ask-overlay").classList.add("hidden");
    askOnAnswer = null;
  }
  $("btn-ask-send").onclick = () => {
    const cb = askOnAnswer;
    const v = $("ask-input").value.trim();
    $("ask-overlay").classList.add("hidden");
    askOnAnswer = null;
    if (cb) cb(v);
  };
  $("btn-ask-cancel").onclick = () => {
    const cb = askOnAnswer;
    $("ask-overlay").classList.add("hidden");
    askOnAnswer = null;
    if (cb) cb("");
  };
  $("ask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("btn-ask-send").click();
    }
  });

  async function finishStream(chat, aMsg) {
    // Все сегменты текущего запуска: помечаем готовыми, пустые промежуточные убираем.
    const segs = runSegments(chat, aMsg);
    const anyText = segs.some((s) => s.content && !s.error);
    const kept = [];
    for (const s of segs) {
      s.pending = false;
      if (!s.content && !s.error) {
        if (!anyText && segs.indexOf(s) === segs.length - 1) s.content = "…";
        else {
          removeSegment(chat, s);
          continue;
        }
      }
      kept.push(s);
    }
    const lastSeg = kept[kept.length - 1] || aMsg;
    setStreaming(false);
    persistChatsNow();
    renderSidebar();
    const el = msgEls.get(lastSeg.id);
    if (el) {
      const b = el.querySelector(".bubble");
      if (b) {
        if (lastSeg.error) {
          b.textContent = lastSeg.error;
        } else {
          b.classList.add("md");
          b.innerHTML = msgHtml(lastSeg.content) || "…";
        }
        b.classList.remove("pending");
      }
    }
    const group = turnPlan && turnPlan.body;
    if (group) {
      group.classList.add("finished");
      updatePlanTitle(turnPlan);
    }
    // Ответ готов: сворачиваем блок «Размышление», если пользователь сам его не трогал
    for (const s of kept) {
      const sEl = msgEls.get(s.id);
      if (!sEl) continue;
      const th = sEl.querySelector(".think");
      if (th && !th.classList.contains("user")) {
        th.classList.add("collapsed");
        const ch = th.querySelector(".think-chev");
        if (ch) ch.textContent = "▸";
      }
    }
    // Кнопки действий под ответом: выполнить план / отменить изменения агента
    if (el && !lastSeg.error) {
      if (lastSeg.plan && lastSeg.content) {
        let actRow = el.querySelector(".ai-actions");
        if (!actRow) {
          actRow = document.createElement("div");
          actRow.className = "ai-actions";
          el.appendChild(actRow);
        }
        const bGo = document.createElement("button");
        bGo.className = "btn btn-primary btn-small";
        bGo.textContent = "▶ Выполнить план";
        bGo.onclick = () => {
          if (streaming) return;
          lastSeg.plan = false;
          const cur = getActiveChat();
          if (!cur) return;
          // Отправляем короткую команду — модель видит предыдущий план в истории
          const inp = $("input");
          inp.value = "Выполни план, который ты составил. Не пересказывай план — сразу действуй.";
          autoResize();
          sendMessage();
        };
        actRow.appendChild(bGo);
      }
      if (isElectron) {
        let n = lastUndoCount;
        if (!n) {
          try {
            const st = await api.undoStatus();
            n = st && st.ok ? st.count : 0;
          } catch {}
        }
        if (n > 0) addUndoButton(el);
      }
    }
    turnPlan = null;
  }

  // Кнопка «Отменить изменения агента» под ответом (чекпоинт последнего запуска).
  // Используется и сразу после ответа, и после перезапуска приложения (чекпоинт на диске).
  function addUndoButton(el) {
    if (!el) return;
    let actRow = el.querySelector(".ai-actions");
    if (!actRow) {
      actRow = document.createElement("div");
      actRow.className = "ai-actions";
      el.appendChild(actRow);
    }
    const bUndo = document.createElement("button");
    bUndo.className = "btn btn-ghost btn-small";
    bUndo.textContent = "↩ Отменить изменения агента (" + (lastUndoCount || 0) + ")";
    bUndo.title = "Вернуть файлы к состоянию до этого ответа";
    bUndo.onclick = async () => {
      if (streaming) return;
      const r = await api.undoRollback();
      lastUndoCount = 0;
      if (r && r.ok) {
        toastShort("✅ Отменено: " + (r.count || 0) + " файлов");
        bUndo.remove();
        if (!$("project-panel").classList.contains("hidden")) refreshProject();
      } else {
        toast("Не удалось отменить изменения");
      }
    };
    actRow.appendChild(bUndo);
  }

  // После перезапуска приложения чекпоинт изменений агента (undo.json) ещё жив —
  // показываем кнопку отката под последним ответом. Вызывается из renderMessages
  // (первый рендер), дальше — один раз, чтобы не дублировать кнопку при смене чатов.
  let undoRestoreShown = false;
  function maybeRestoreUndoButton() {
    if (undoRestoreShown || !isElectron) return;
    undoRestoreShown = true;
    api.undoStatus().then((st) => {
      if (!(st && st.ok && st.count > 0)) return;
      lastUndoCount = st.count;
      const chat = getActiveChat();
      const lastAssistant =
        chat && [...chat.messages].reverse().find((m) => m.role === "assistant" && !m.error);
      if (lastAssistant) addUndoButton(msgEls.get(lastAssistant.id));
    });
  }

  // Баннер «нужна модель» на приветственном экране. Бейдж модели всегда статичен.
  function updateModelNeeded() {
    const chat = getActiveChat();
    const show = !settings.model && (!chat || !chat.messages.length);
    $("model-needed").classList.toggle("hidden", !show);
    updateBadge();
  }


  function setStreaming(v) {
    streaming = v;
    $("typing").classList.toggle("hidden", !v);
    $("btn-stop").classList.toggle("hidden", !v);
    $("btn-send").classList.toggle("hidden", v);
  }

  function stop() {
    if (isElectron) api.stopMessage();
    else if (webAbort) webAbort.abort();
  }

  // ─────────────── Веб-режим: чат напрямую из браузера ───────────────
  // Единый цикл на общем транспорте AgentCore (те же правила, что и в Electron main).
  // Инструменты (файлы/git) в браузере недоступны — только чат.
  let webAutoSwitches = 0; // счётчик авто-переключений за запуск (защита от бесконечного круга)
  const webProfileCooldown = new Map(); // profileId → timestamp: провинившийся ключ откладываем

  // Авто-переключение между сохранёнными OpenAI-подключениями при ошибке (браузерный путь).
  // Возвращает true, если переключились (вызывающий должен повторить раунд).
  function tryWebAutoSwitch(errText) {
    if (!settings.autoSwitchProfiles || settings.provider !== "openai") return false;
    // Меняем ключ только если ошибка про ключ/баланс/лимит (400, контент, сеть — не про ключ).
    const cls = (typeof AgentCore !== "undefined" && AgentCore.classifyKeyError)
      ? AgentCore.classifyKeyError(errText)
      : { key: true, cooldownMs: 60 * 1000 };
    if (!cls.key) return false;
    const profs = openaiProfilesArr().filter((p) => p && p.id && String(p.apiKey || "").trim());
    if (profs.length < 2) return false;
    if (webAutoSwitches >= profs.length) return false; // прошли полный круг — стоп
    const cur = settings.openaiActiveProfile;
    const idx = Math.max(0, profs.findIndex((p) => p.id === cur));
    const now = Date.now();
    webProfileCooldown.set(cur, now + cls.cooldownMs); // провинившийся ключ отлеживается
    for (let step = 1; step <= profs.length; step++) {
      const next = profs[(idx + step) % profs.length];
      if (!next || next.id === cur) continue;
      if ((webProfileCooldown.get(next.id) || 0) > now) continue; // ещё в кулдауне
      webAutoSwitches++;
      settings.openaiActiveProfile = next.id;
      settings.openaiUrl = next.url || settings.openaiUrl;
      settings.openaiApiKey = next.apiKey || "";
      if (next.model) settings.openaiModel = next.model;
      if (next.project !== undefined) settings.openaiProject = next.project || "";
      persistSettings();
      onEvent({ type: "profile_switched", name: next.name || next.id, id: next.id, error: String(errText || "").slice(0, 160) });
      return true;
    }
    return false; // все ключи в кулдауне — переключать некуда
  }

  async function webSend(messages, onEvent, signal, opts) {
    opts = opts || {};
    webAutoSwitches = 0; // сброс счётчика авто-переключений на каждый запуск
    const planMode = !!opts.plan;
    const provider = settings.provider || "openai";
    if (!settings.model) {
      onEvent({ type: "error", message: "Не выбрана модель. Открой Настройки." });
      return;
    }
    // Контекст-окно (в браузере те же бюджеты, что и в Electron)
    let budget = AgentCore.contextBudget(provider, settings.model);
    let contextRetried = false; // при переполнении контекста пробуем ещё раз с меньшим бюджетом
    try {
      messages = AgentCore.trimConversation(messages, budget);
    } catch {}
    let apiMessages = [
      {
        role: "system",
        content:
          AgentCore.SYSTEM_PROMPT +
          (settings.workingDir ? "\n\nРабочая директория: " + settings.workingDir : "") +
          (planMode
            ? "\n\nРЕЖИМ ПЛАНА: сейчас НЕ выполняй инструменты и НЕ изменяй файлы. Составь пошаговый план работ и перечисли файлы, которые затронешь. Жди команды пользователя."
            : ""),
      },
      ...messages,
    ];
    const maxRounds = planMode ? 3 : 10;
    let finalText = "";

    for (let round = 0; round < maxRounds; round++) {
      let collected = "";
      const toolCalls = [];
      const stripper = AgentCore.createThinkingStripper({ onHidden: (t) => onEvent({ type: "thinking", text: t }) });

      // Контекст-менеджмент: держим историю в рамках бюджета между раундами
      if (apiMessages.length > 1) {
        apiMessages = [apiMessages[0], ...AgentCore.trimConversation(apiMessages.slice(1), budget)];
      }
      // Финальный предохранитель перед отправкой: осиротевшие tool-сообщения
      // (role:"tool" без предшествующего assistant с tool_calls) — 400 wrong_api_format.
      if (apiMessages.length > 1) {
        apiMessages = [apiMessages[0], ...AgentCore.sanitizeToolPairs(apiMessages.slice(1))];
      }

      const req = AgentCore.buildChatRequest(settings, {
        model: settings.model,
        messages: apiMessages,
        tools: planMode ? AgentCore.PLAN_MODE_TOOL_DEFINITIONS : AgentCore.TOOL_DEFINITIONS,
        fromBrowser: true,
      });
      let res;
      try {
        res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        if (tryWebAutoSwitch(e.message)) { round--; continue; }
        onEvent({ type: "error", message: "Сетевая ошибка: " + e.message });
        return;
      }
      if (!res.ok) {
        const detail = await AgentCore.readApiError(res);
        // Лимиты провайдера (Groq free ~7K токенов/мин): понятное объяснение вместо сырого JSON.
        const friendly = AgentCore.friendlyRateLimitError(res.status, detail, settings);
        if (friendly) {
          if (tryWebAutoSwitch(friendly)) { round--; continue; }
          onEvent({ type: "error", message: friendly });
          return;
        }
        // Переполнение контекста: один раз повторяем с резко урезанной историей
        if (!contextRetried && /context|too long|maximum|num_ctx|token/i.test(detail) && budget > 3000) {
          contextRetried = true;
          budget = Math.max(3000, Math.floor(budget * 0.4));
          if (apiMessages.length > 1) {
            apiMessages = [apiMessages[0], ...AgentCore.trimConversation(apiMessages.slice(1), budget)];
          }
          round--;
          continue;
        }
        if (res.status === 402) {
          if (tryWebAutoSwitch("API error 402: недостаточно средств")) { round--; continue; }
          onEvent({
            type: "error",
            message: "API error 402: Недостаточно средств на балансе провайдера. Пополни счёт (platform.deepseek.com → Top up) или выбери другого провайдера/модель в настройках.",
          });
          return;
        }
        if (tryWebAutoSwitch("API error " + res.status + ": " + detail)) { round--; continue; }
        onEvent({ type: "error", message: "API error " + res.status + ": " + detail });
        return;
      }

      await AgentCore.consumeProviderStream({
        response: res,
        provider,
        onText: (text) => {
          const vis = stripper.push(text);
          if (vis) {
            collected += vis;
            onEvent({ type: "chunk", text: vis });
          }
        },
        onToolCall: (tc) => toolCalls.push(tc),
        onThinking: (t) => onEvent({ type: "thinking", text: t }),
      });

      const tail = stripper.finish();
      if (tail) {
        collected += tail;
        onEvent({ type: "chunk", text: tail });
      }
      finalText = collected;

      // Запасной способ вызова инструментов (модель напечатала JSON текстом).
      // В режиме плана инструменты не выполняются — план только составляется.
      if (toolCalls.length === 0 && !planMode) {
        const fallbackCalls = AgentCore.extractToolCallsFromText(finalText);
        for (const fc of fallbackCalls) {
          toolCalls.push({ id: AgentCore.genCallId(), name: fc.name, args: fc.args });
        }
        if (fallbackCalls.length) {
          let cleaned = finalText;
          for (const fc of fallbackCalls) {
            cleaned = cleaned.split(fc.raw).join("");
          }
          cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
          if (cleaned) onEvent({ type: "text_override", text: cleaned });
        }
      }
      if (toolCalls.length === 0) {
        onEvent({ type: "done" });
        return;
      }

      // Нормализуем имена, назначаем стабильные id и убираем дубли одного раунда
      const seenCalls = new Set();
      const calls = [];
      for (const tc of toolCalls) {
        const norm = {
          id: tc.id || AgentCore.genCallId(),
          name: AgentCore.normalizeToolName(tc.name),
          args: tc.args && typeof tc.args === "object" ? tc.args : {},
          // Gemini 3.x: extra_content с thought signature нужно вернуть дословно,
          // иначе следующий раунд упадёт с 400 (missing thought_signature).
          ...(tc.extraContent ? { extraContent: tc.extraContent } : {}),
        };
        const sig = norm.name + "|" + JSON.stringify(norm.args);
        if (seenCalls.has(sig)) continue;
        seenCalls.add(sig);
        calls.push(norm);
      }
      // Все вызовы раунда оказались дублями — завершаем без «пустых» tool_calls.
      if (!calls.length) {
        if (!String(finalText || "").trim()) finalText = "Готово.";
        onEvent({ type: "chunk", text: finalText });
        onEvent({ type: "done" });
        return;
      }
      apiMessages.push({
        role: "assistant",
        content: finalText || null,
        tool_calls: calls.map((c) => {
          const call = {
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
          };
          if (c.extraContent) call.extra_content = c.extraContent;
          return call;
        }),
      });
      for (const c of calls) {
        onEvent({ type: "tool_start", name: c.name, args: c.args });
        let result;
        if (c.name === "askUser") {
          // В веб-режиме askUser тоже работает: спрашиваем через модалку
          const question = (c.args && c.args.question) || "Уточни, пожалуйста";
          result = await new Promise((resolve) => openAskModal(question, resolve));
          result = result && String(result).trim() ? String(result).trim() : "(пользователь не дал ответ)";
        } else if (c.name === "webSearch" || c.name === "webFetch") {
          // Веб-поиск и чтение страниц работают и в браузере: запрос идёт через
          // preview-сервер (/api/…), потому что DuckDuckGo и сайты блокируют CORS.
          const q = c.name === "webSearch"
            ? encodeURIComponent(((c.args && (c.args.query || c.args.q)) || "").trim())
            : encodeURIComponent(((c.args && c.args.url) || "").trim());
          const endpoint = c.name === "webSearch" ? "/api/search?q=" : "/api/fetch?url=";
          try {
            const r = await fetch(endpoint + q);
            result = r.ok ? await r.text() : "Ошибка " + c.name + ": HTTP " + r.status;
          } catch (e) {
            result = "Ошибка " + c.name + ": " + (e && e.message ? e.message : "сеть недоступна");
          }
        } else if (c.name === "waitUntil") {
          // Обычная пауза — работает и в браузере.
          const secs = Math.max(1, Math.min(parseInt((c.args && c.args.seconds) || "5", 10) || 5, 300));
          await new Promise((r) => setTimeout(r, secs * 1000));
          result = "OK — подождал " + secs + " с. Теперь перепроверь состояние (checkPort/checkUrl/backgroundOutput).";
        } else if (c.name === "todoWrite") {
          // План работ — чистая структура, работает и в веб-превью.
          const webTasks = AgentCore.normalizePlanTasks(c.args && (c.args.tasks != null ? c.args.tasks : c.args.items));
          if (!webTasks.length) {
            result = "Ошибка: план пуст — пришли непустой массив tasks (до 7 пунктов).";
          } else {
            onEvent({ type: "plan", tasks: webTasks, title: String((c.args && c.args.title) || "").slice(0, 80) });
            const wp = AgentCore.planSummary(webTasks);
            result = planMode
              ? "OK — план показан пользователю (" + wp.total + " пункт(ов)). Режим плана: инструменты не выполняются — жди команды «Выполнить»."
              : "OK — план показан пользователю: " + wp.done + " из " + wp.total + " готово" +
                (wp.failed ? ", сбоев: " + wp.failed : "") +
                ". Продолжай со следующего пункта и после каждого шага вызывай todoWrite заново с полным списком.";
          }
        } else if (c.name === "semanticSearch") {
          result =
            "⚠️ Семантический поиск (semanticSearch) доступен только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name === "otaStatus" || c.name === "otaCheck" || c.name === "otaRollback") {
          result =
            "⚠️ Инструменты самообновления (otaStatus/otaCheck/otaRollback) доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name === "applyPatch" || c.name === "gitStash" || c.name === "gitCherryPick" || c.name === "gitBlame") {
          result =
            "⚠️ Инструменты applyPatch и gitStash/gitCherryPick/gitBlame доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name === "agentGuide") {
          // Справочники лежат рядом с кодом приложения — в браузере их не читать.
          result =
            "⚠️ Справочники по сайтам (agentGuide) доступны в desktop-приложении (bun run dist:win). В веб-версии ищи по DOM: browserSnapshot/browserScroll недоступны — работай через webFetch.";
        } else if (c.name === "waitForIdle") {
          // Обычная пауза — в браузере тоже работает (нечего ждать по DOM-мутациям).
          const secs = Math.max(1, Math.min(parseInt((c.args && (c.args.quietMs || c.args.timeout)) || "1500", 10) / 1000, 30));
          await new Promise((r) => setTimeout(r, Math.round(secs * 1000)));
          result = "OK — подождал " + secs.toFixed(1) + " с (в веб-версии ожидание покоя = пауза).";
        } else if (c.name && (c.name.startsWith("browser") || c.name.startsWith("app"))) {
          // Браузерные (Playwright) и app-инструменты (управление собственным окном)
          // работают только в desktop-приложении (main-процесс Electron).
          result =
            "⚠️ Инструменты браузера (browserOpen и др.) и управления окном приложения (appRead/appClick и др.) доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name && (c.name === "noteSave" || c.name === "noteRead" || c.name === "noteList" || c.name === "noteDelete" || c.name === "checkpointSave" || c.name === "checkpointList" || c.name === "checkpointRollback")) {
          // Память проекта и точки отката работают только в desktop-приложении.
          result =
            "⚠️ Инструменты памяти проекта (noteSave/noteRead/noteList/noteDelete) и точек отката (checkpointSave/checkpointList/checkpointRollback) доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name === "ycStatus" || c.name === "ycList" || c.name === "ycCreate" || c.name === "ycDelete" || c.name === "ycDeploy" || c.name === "ycLogs") {
          result =
            "⚠️ Инструменты Yandex Cloud (ycStatus/ycList/ycCreate/ycDelete) доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else {
          result =
            "⚠️ Файловые операции и git недоступны в веб-версии. Запустите приложение на Windows (bun run dist:win).";
        }
        onEvent({ type: "tool_result", name: c.name, result });
        apiMessages.push({ role: "tool", tool_call_id: c.id, content: result });
      }
    }
    onEvent({ type: "error", message: "Превышено максимальное число раундов вызова инструментов (" + maxRounds + ")." });
  }

  // ─────────────── Настройки ───────────────
  function providerLabel() {
    if (settings.provider === "ollama") return "Ollama";
    if (settings.provider === "anthropic") return "Claude";
    return PRESET_LABEL[currentPreset] || "OpenAI-совместимый";
  }
  function updateBadge() {
    const label = providerLabel();
    $("model-badge").textContent = settings.model ? label + " · " + settings.model : "Модель не выбрана";
    $("model-badge").title = settings.model
      ? "Провайдер и модель — нажми, чтобы изменить"
      : "Модель не выбрана — нажми, чтобы настроить";
    updateStatusBar();
  }

  function setSettingsMsg(text, isError) {
    const msg = $("settings-msg");
    msg.textContent = text;
    msg.className = "settings-msg " + (isError ? "err" : "ok");
  }

  function setProviderUI(p) {
    if (p !== "ollama" && p !== "openai" && p !== "anthropic") p = "openai";
    settings.provider = p;
    const provSel = $("s-provider-select");
    if (provSel) provSel.value = p;
    // Аккордеон: раскрываем карточку активного провайдера, остальные сворачиваем.
    // Вручную раскрыть другую карточку можно кликом по её заголовку — это не меняет выбор.
    for (const key of ["ollama", "openai", "anthropic"]) {
      const acc = document.querySelector('.acc[data-acc="' + key + '"]');
      if (!acc) continue;
      acc.classList.toggle("open", key === p);
      const badge = acc.querySelector(".acc-badge");
      if (badge) badge.classList.toggle("hidden", key !== p);
    }
    // Переключаем зеркало модели на сохранённую модель выбранного провайдера,
    // чтобы случайно не отправить модель от другого провайдера.
    settings.model = settings[MODEL_KEY[p]] || "";
    updateBadge();
    renderModelHints(null, null); // подсказки моделей относятся к активному провайдеру
  }

  // Переключение вкладок настроек
  function showSettingsTab(name) {
    document.querySelectorAll(".stab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".settings-tab-body").forEach((b) => b.classList.toggle("hidden", b.dataset.tabBody !== name));
  }

  function setPreset(p) {
    currentPreset = p;
    // Только пресеты из настроек: селектор без [data-preset] задел бы чипы
    // приветственного экрана и переключил бы их «активный» вид.
    document.querySelectorAll(".chip[data-preset]").forEach((c) => c.classList.toggle("active", c.dataset.preset === p));
    if (PRESETS[p] && PRESETS[p].url) $("s-openai-url").value = PRESETS[p].url;
    if (PRESETS[p] && PRESETS[p].model) $("s-openai-model").value = PRESETS[p].model;
    // Поле «Yandex folder ID» — только для Yandex AI Studio
    const yandexField = $("yandex-project-field");
    if (yandexField) yandexField.classList.toggle("hidden", p !== "yandex");
    // Подсказка G4F — только при выборе локального пресета
    const g4fHint = $("g4f-hint");
    if (g4fHint) g4fHint.classList.toggle("hidden", p !== "g4f");
    // Авто-подбор порта: если указанный URL не отвечает, а живой g4f есть на 1337/8080
    if (p === "g4f") probeG4fPort();
  }

  // Заполняет все поля настроек значениями из памяти (чтобы переключение провайдеров ничего не теряло)
  function fillSettingsUI() {
    $("s-ollama-url").value = settings.ollamaUrl || "";
    $("s-ollama-model").value = settings.ollamaModel || "";
    $("s-openai-url").value = settings.openaiUrl || "";
    $("s-openai-key").value = settings.openaiApiKey || "";
    $("s-openai-model").value = settings.openaiModel || "";
    $("s-openai-project").value = settings.openaiProject || "";
    $("s-anth-url").value = settings.anthropicUrl || "";
    $("s-anth-key").value = settings.anthropicApiKey || "";
    $("s-anth-model").value = settings.anthropicModel || "";
    $("s-workdir").value = settings.workingDir || "";
    $("s-gh-client-id").value = settings.githubClientId || "";
    $("s-gh-token").value = settings.githubToken || "";
    $("s-allow-agent-push").checked = !!settings.allowAgentPush;
    $("s-agent-auto-commit").checked = settings.agentAutoCommit !== false;
    $("s-context-memory").checked = settings.contextMemory === true;
    $("s-context-memory-days").value = settings.contextMemoryDays || 30;
    renderMemoryStatus();
    $("s-browser-profile").checked = settings.browserProfile !== false;
    renderBrowserProfileInfo();
    if ($("s-browser-connect")) {
      $("s-browser-connect").checked = settings.browserConnect === true;
      $("s-browser-connect-port").value = settings.browserConnectPort || 9222;
      renderBrowserConnectInfo();
    }
    $("s-mobile-enabled").checked = !!settings.mobileEnabled;
    $("s-mobile-port").value = settings.mobilePort || 9090;
    renderMobileStatus();
    $("s-vision-enabled").checked = !!settings.visionEnabled;
    $("s-vision-auto").checked = settings.visionAuto !== false;
    $("s-vision-url").value = settings.visionUrl || "";
    $("s-vision-key").value = settings.visionKey || "";
    $("s-serper-key").value = settings.serperApiKey || "";
    $("s-vision-model").value = settings.visionModel || "";
    $("s-image-model").value = settings.imageModel || "";
    $("vision-fields").classList.toggle("hidden", !$("s-vision-enabled").checked);
    $("vision-model-hints").classList.add("hidden");
    $("s-ota-enabled").checked = settings.otaEnabled !== false;
    $("s-ota-dir").value = settings.otaDir || "";
    renderOpenaiProfiles();
    $("s-auto-switch").checked = !!settings.autoSwitchProfiles;
    $("s-send-all-tools").checked = !!settings.sendAllTools;
    // Почта
    $("s-mail-address").value = settings.mailAddress || "";
    $("s-mail-from-name").value = settings.mailFromName || "";
    $("s-mail-pass").value = settings.mailPassword || "";
    $("s-mail-imap-host").value = settings.mailImapHost || "";
    $("s-mail-imap-port").value = settings.mailImapPort ? String(settings.mailImapPort) : "";
    $("s-mail-smtp-host").value = settings.mailSmtpHost || "";
    $("s-mail-smtp-port").value = settings.mailSmtpPort ? String(settings.mailSmtpPort) : "";
    $("s-mail-starttls").checked = !!settings.mailStarttls;
    $("s-mail-allow-send").checked = !!settings.mailAllowAgentSend;
    renderOtaStatus();
  }

  // Читает значения активного провайдера из полей в settings
  function collectSettingsFromUI() {
    settings.ollamaUrl = $("s-ollama-url").value.trim() || "http://localhost:11434";
    settings.ollamaModel = $("s-ollama-model").value.trim();
    settings.openaiUrl = $("s-openai-url").value.trim();
    settings.openaiApiKey = $("s-openai-key").value.trim();
    settings.openaiModel = $("s-openai-model").value.trim();
    settings.openaiProject = $("s-openai-project").value.trim();
    settings.anthropicUrl = $("s-anth-url").value.trim() || "https://api.anthropic.com";
    settings.anthropicApiKey = $("s-anth-key").value.trim();
    settings.anthropicModel = $("s-anth-model").value.trim();
    settings.workingDir = $("s-workdir").value.trim();
    settings.githubClientId = $("s-gh-client-id").value.trim();
    settings.githubToken = $("s-gh-token").value.trim();
    settings.allowAgentPush = !!$("s-allow-agent-push").checked;
    settings.agentAutoCommit = !!$("s-agent-auto-commit").checked;
    settings.contextMemory = !!$("s-context-memory").checked;
    settings.contextMemoryDays = Math.max(1, Math.min(3650, parseInt($("s-context-memory-days").value, 10) || 30));
    settings.browserProfile = !!$("s-browser-profile").checked;
    if ($("s-browser-connect")) {
      settings.browserConnect = !!$("s-browser-connect").checked;
      settings.browserConnectPort = parseInt($("s-browser-connect-port").value, 10) || 9222;
    }
    settings.mobileEnabled = !!$("s-mobile-enabled").checked;
    settings.mobilePort = parseInt($("s-mobile-port").value, 10) || 9090;
    settings.visionEnabled = !!$("s-vision-enabled").checked;
    settings.visionAuto = !!$("s-vision-auto").checked;
    settings.visionUrl = $("s-vision-url").value.trim();
    settings.visionKey = $("s-vision-key").value.trim();
    settings.serperApiKey = $("s-serper-key").value.trim();
    settings.mailAddress = $("s-mail-address").value.trim();
    settings.mailFromName = $("s-mail-from-name").value.trim();
    settings.mailPassword = $("s-mail-pass").value.trim();
    settings.mailImapHost = $("s-mail-imap-host").value.trim();
    settings.mailImapPort = parseInt($("s-mail-imap-port").value, 10) || 993;
    settings.mailSmtpHost = $("s-mail-smtp-host").value.trim();
    settings.mailSmtpPort = parseInt($("s-mail-smtp-port").value, 10) || 465;
    settings.mailStarttls = !!$("s-mail-starttls").checked;
    settings.mailAllowAgentSend = !!$("s-mail-allow-send").checked;
    settings.visionModel = $("s-vision-model").value.trim();
    settings.imageModel = $("s-image-model").value.trim();
    settings.otaEnabled = !!$("s-ota-enabled").checked;
    settings.otaDir = $("s-ota-dir").value.trim();
    settings.autoSwitchProfiles = !!$("s-auto-switch").checked;
    settings.sendAllTools = !!$("s-send-all-tools").checked;
    // Зеркало модели активного провайдера
    settings.model = settings[MODEL_KEY[settings.provider]] || "";
  }

  // ── Сохранённые OpenAI-подключения (несколько ключей) ──
  function profileNameFromUrl(url) {
    try {
      const m = String(url || "").match(/^https?:\/\/([^\/:?#]+)/i);
      return m ? m[1].replace(/^www\./, "") : "OpenAI";
    } catch {
      return "OpenAI";
    }
  }

  function openaiProfilesArr() {
    return Array.isArray(settings.openaiProfiles) ? settings.openaiProfiles : [];
  }

  // Перерисовывает выпадающий список сохранённых подключений
  function renderOpenaiProfiles() {
    const sel = $("s-openai-profile");
    if (!sel) return;
    const profs = openaiProfilesArr();
    sel.innerHTML = "";
    const optNew = document.createElement("option");
    optNew.value = "__new__";
    optNew.textContent = "➕ Новое подключение…";
    sel.appendChild(optNew);
    for (const p of profs) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name + (p.model ? " · " + p.model : "") + (String(p.apiKey || "").trim() ? "" : " (без ключа)");
      sel.appendChild(o);
    }
    sel.value =
      settings.openaiActiveProfile && profs.some((p) => p.id === settings.openaiActiveProfile)
        ? settings.openaiActiveProfile
        : "__new__";
  }

  // Применяет выбранное подключение к полям URL/ключ/модель/проект
  function applyOpenaiProfile(id) {
    const p = openaiProfilesArr().find((x) => x.id === id);
    if (!p) return;
    settings.openaiActiveProfile = p.id;
    $("s-openai-url").value = p.url || "";
    $("s-openai-key").value = p.apiKey || "";
    $("s-openai-model").value = p.model || "";
    $("s-openai-project").value = p.project || "";
    // Подсвечиваем пресет-чип по URL (не трогая поля — у подключения свои значения)
    const url = String(p.url || "").toLowerCase();
    let found = "";
    for (const [k, v] of Object.entries(PRESETS)) {
      if (v && v.url && url.includes(String(v.url).replace(/\/+$/, "").toLowerCase())) { found = k; break; }
    }
    document.querySelectorAll(".chip[data-preset]").forEach((c) => c.classList.toggle("active", c.dataset.preset === (found || "custom")));
    setSettingsMsg("Подключение «" + (p.name || p.id) + "» выбрано. Нажми «Сохранить настройки».", false);
  }

  // Сохраняет текущие URL/ключ/модель как новое подключение или обновляет выбранное
  function saveOpenaiProfileFromFields() {
    const sel = $("s-openai-profile");
    const profs = openaiProfilesArr();
    const url = $("s-openai-url").value.trim();
    if (!url) { setSettingsMsg("Сначала заполни базовый URL — без него подключение не сохранить.", true); return; }
    const key = $("s-openai-key").value.trim();
    const model = $("s-openai-model").value.trim();
    const project = $("s-openai-project").value.trim();
    const editingId = sel.value !== "__new__" ? sel.value : "";
    if (editingId) {
      const p = profs.find((x) => x.id === editingId);
      if (!p) return;
      p.url = url; p.apiKey = key; p.model = model; p.project = project;
      settings.openaiActiveProfile = p.id;
      setSettingsMsg("Подключение «" + (p.name || p.id) + "» обновлено.", false);
    } else {
      let name = profileNameFromUrl(url);
      const same = profs.filter((x) => x.name === name).length;
      if (same) name = name + " #" + (same + 1);
      profs.push({ id: uid(), name, url, apiKey: key, model, project });
      settings.openaiActiveProfile = profs[profs.length - 1].id;
      setSettingsMsg("Подключение «" + name + "» сохранено. Переключайся между ключами в один клик.", false);
    }
    persistSettings();
    renderOpenaiProfiles();
  }

  function deleteOpenaiProfile() {
    const sel = $("s-openai-profile");
    if (sel.value === "__new__") { setSettingsMsg("Выбери подключение из списка, чтобы удалить его.", true); return; }
    const profs = openaiProfilesArr();
    const p = profs.find((x) => x.id === sel.value);
    if (!p) return;
    if (!confirm("Удалить подключение «" + (p.name || p.id) + "»?")) return;
    settings.openaiProfiles = profs.filter((x) => x.id !== p.id);
    if (settings.openaiActiveProfile === p.id) settings.openaiActiveProfile = "";
    persistSettings();
    renderOpenaiProfiles();
    setSettingsMsg("Подключение удалено.", false);
  }

  // Статус локального self-update (OTA): версия, папка, источники
  async function renderOtaStatus() {
    const el = $("ota-status");
    if (!el) return;
    if (!isElectron) {
      el.textContent = "Доступно в приложении на ПК";
      return;
    }
    try {
      const st = await api.otaStatus();
      sbVersion = (st && st.installed) || "базовая";
      updateStatusBar();
      const parts = ["Версия кода: " + ((st && st.installed) || "базовая")];
      if (st && st.dir) parts.push("Папка: " + st.dir);
      if (st && st.sources && st.sources.length) parts.push("Обновлений найдено: " + st.sources.length);
      el.textContent = parts.join(" · ");
    } catch {
      el.textContent = "—";
    }
  }

  function openSettings() {
    renderEnvVars();
    renderVault();
    fillSettingsUI();
    showSettingsTab("model"); // всегда открываем с вкладки «Модель»
    setProviderUI(settings.provider || "openai");
    setPreset(currentPreset);
    // Определяем пресет по сохранённому URL (если он не пустой и совпадает с известным)
    const url = (settings.openaiUrl || "").toLowerCase();
    let found = false;
    for (const [k, v] of Object.entries(PRESETS)) {
      if (v && url.includes(v.url.replace(/\/+$/, "").toLowerCase())) {
        setPreset(k);
        found = true;
        break;
      }
    }
    if (!found) setPreset(settings.openaiUrl ? "custom" : "deepseek");
    renderModelHints(null, null); // прячем подсказки моделей (провайдер мог смениться)
    renderGithubSection();
    ycRefreshSettingsUI(); // Yandex Cloud: статус подключения, каталог, разрешения
    $("settings-overlay").classList.remove("hidden");
    setSettingsMsg("", false);
  }

  // Кликабельные подсказки с моделями под активным провайдером
  function renderModelHints(provider, models) {
    cachedModels[provider] = models || [];
    const box = $("model-hints");
    box.innerHTML = "";
    if (!provider || !models || !models.length) {
      box.classList.add("hidden");
      return;
    }
    const label = document.createElement("span");
    label.className = "hint-label";
    label.textContent = "Модели (клик — вставить):";
    box.appendChild(label);
    const shown = models.slice(0, 12);
    for (const name of shown) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (name === (settings[MODEL_KEY[provider]] || settings.model) ? " active" : "");
      b.textContent = name;
      b.title = "Вставить модель " + name;
      b.onclick = () => {
        // На пресете G4F в поле модели может стоять маршрут «Провайдер:» — не затираем его:
        // модель дописывается после двоеточия, иначе теряется выбранный провайдер.
        const input = $(MODEL_INPUT[provider]);
        const curVal = (input.value || "").trim();
        const g4fPrefix = /^[A-Za-z0-9_]+:\s*$/.test(curVal) ? curVal.replace(/:+$/, "") + ":" : "";
        const finalName = g4fPrefix + name;
        input.value = finalName;
        settings[MODEL_KEY[provider]] = finalName;
        settings.model = finalName;
        persistSettings();
        updateBadge();
        setSettingsMsg("Модель выбрана: " + finalName + ". Нажми «Сохранить настройки» и общайся.", false);
        renderModelHints(provider, models);
        if (currentPreset === "g4f") renderG4fProviderList();
      };
      box.appendChild(b);
    }
    box.classList.remove("hidden");
  }

  // Список моделей для активного провайдера (по значениям из полей настроек)
  async function requestModelsList() {
    const provider = settings.provider || "openai";
    const base = $(URL_INPUT[provider]).value.trim();
    const key = provider === "anthropic" ? $("s-anth-key").value.trim() : $("s-openai-key").value.trim();
    const cfg = { ...settings, provider, [URL_KEY[provider]]: base, model: "" };
    if (provider === "anthropic") cfg.anthropicApiKey = key;
    else cfg.openaiApiKey = key;
    if (isElectron) {
      const res = await api.listModels(cfg);
      return res && res.ok ? res.models : { error: (res && res.message) || "Не удалось загрузить" };
    }
    try {
      return await AgentCore.listModels(cfg, { fromBrowser: true });
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  async function loadModels() {
    collectSettingsFromUI();
    const provider = settings.provider || "openai";
    if (!$(URL_INPUT[provider]).value.trim()) {
      setSettingsMsg("Заполни базовый URL провайдера.", true);
      return;
    }
    setSettingsMsg("Загружаю список моделей...", false);
    const res = await requestModelsList();
    if (Array.isArray(res) && res.length) {
      renderModelHints(provider, res);
      setSettingsMsg(
        "Доступно моделей: " + res.length + ". Нажми на нужную ниже, чтобы вставить её в поле.",
        false
      );
    } else {
      renderModelHints(provider, null);
      setSettingsMsg("Модели не загрузились: " + (res.error || ""), true);
    }
  }

  async function testConnection() {
    collectSettingsFromUI();
    const provider = settings.provider || "openai";
    if (!$(URL_INPUT[provider]).value.trim()) {
      setSettingsMsg("Заполни базовый URL провайдера.", true);
      return;
    }
    setSettingsMsg("Проверяю подключение...", false);
    const res = await requestModelsList();
    if (Array.isArray(res)) {
      renderModelHints(provider, res);
      setSettingsMsg("Подключено! Моделей: " + res.length + ". Нажми на нужную ниже, чтобы выбрать.", false);
    } else {
      renderModelHints(provider, null);
      setSettingsMsg("Ошибка: " + (res.error || "не удалось подключиться"), true);
    }
  }

  // ── Мобильный доступ: статус моста, PIN, адреса для телефона ──
  async function renderMobileStatus() {
    const box = $("mobile-fields");
    const urls = $("mobile-urls");
    if (!isElectron || !api.mobileStatus) {
      if (box) box.classList.add("hidden");
      return;
    }
    box.classList.toggle("hidden", !$("s-mobile-enabled").checked);
    try {
      const st = await api.mobileStatus();
      if (!st) return;
      if ($("s-mobile-pin")) $("s-mobile-pin").value = st.pin || "";
      urls.innerHTML = "";
      const list = (st.urls && st.urls.length) ? st.urls : [{ url: st.url || "—" }];
      for (const u of list) {
        const a = document.createElement("a");
        a.className = "mobile-url-chip";
        a.href = u.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = u.url;
        urls.appendChild(a);
      }
      if (!st.urls || !st.urls.length) {
        const span = document.createElement("span");
        span.className = "mobile-url-none";
        span.textContent = "Нет доступных адресов — проверь подключение ПК к сети.";
        urls.appendChild(span);
      }
      if (st.enabled && !st.running) {
        const err = document.createElement("div");
        err.className = "mobile-url-none";
        err.textContent = "⚠ Мост не запустился (порт занят?). Попробуй другой порт.";
        urls.appendChild(err);
      }
    } catch (e) {
      urls.innerHTML = "";
      const span = document.createElement("span");
      span.className = "mobile-url-none";
      span.textContent = "Статус недоступен: " + (e.message || "");
      urls.appendChild(span);
    }
  }

  async function regenerateMobilePin() {
    if (!isElectron || !api.mobilePinRegen) return;
    try {
      const st = await api.mobilePinRegen();
      if (st && st.pin) {
        settings.mobilePin = st.pin;
        $("s-mobile-pin").value = st.pin;
        setSettingsMsg("Новый PIN: " + st.pin + " — покажи его на телефоне.", false);
      }
    } catch (e) {
      setSettingsMsg("Не удалось сменить PIN: " + (e.message || ""), true);
    }
  }

  // Загрузка списка моделей для вспомогательной модели (зрение/генерация)
  async function loadAuxModels(kind) {
    const box = $("vision-model-hints");
    box.innerHTML = "";
    const url = $("s-vision-url").value.trim() || settings.visionUrl || "https://openrouter.ai/api/v1";
    const key = $("s-vision-key").value.trim() || settings.visionKey || settings.openaiApiKey || "";
    box.classList.remove("hidden");
    if (!key) {
      box.innerHTML = '<span class="hint-label">Сначала укажи API-ключ вспомогательной модели.</span>';
      return;
    }
    box.innerHTML = '<span class="hint-label">Загружаю модели…</span>';
    try {
      const cfg = { provider: "openai", openaiUrl: url, openaiApiKey: key, model: "" };
      const res = isElectron ? await api.listModels(cfg) : await AgentCore.listModels(cfg, { fromBrowser: true });
      const models = Array.isArray(res) ? res : (res && res.models) || [];
      if (!models.length) {
        box.innerHTML = '<span class="hint-label">Модели не загрузились: ' + esc(((res && res.message) || "пустой ответ")) + "</span>";
        return;
      }
      box.innerHTML = "";
      for (const name of models) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = name;
        b.title = "Вставить " + name;
        b.onclick = () => {
          if (kind === "vision") { $("s-vision-model").value = name; settings.visionModel = name; }
          else { $("s-image-model").value = name; settings.imageModel = name; }
          persistSettings();
          box.innerHTML = "";
          box.classList.add("hidden");
        };
        box.appendChild(b);
      }
    } catch (e) {
      box.innerHTML = '<span class="hint-label">Ошибка: ' + esc((e && e.message) || String(e)) + "</span>";
    }
  }

  // Токены в коротком виде: 12400 → «12.4k»
  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v < 1000) return String(v);
    return (Math.round(v / 100) / 10).toFixed(1).replace(/\.0$/, "") + "k";
  }

  // Полоска заполняемости контекста модели под полем ввода (приходит событием "context").
  function renderContext(ev) {
    const el = $("ctx-indicator");
    if (!el || !$("ctx-fill") || !$("ctx-text")) return;
    const used = Number((ev && ev.used) || 0);
    const budget = Number((ev && ev.budget) || 0);
    // Процент считаем от бюджета: при переполнении он честно больше 100, а не
    // «упирается» в 100 (раньше при 62 000 из 50 000 показывалось «100%»).
    const pct = budget > 0 ? Math.round((used / budget) * 100) : Math.max(0, parseInt(ev && ev.percent, 10) || 0);
    const barPct = Math.max(0, Math.min(100, pct));
    const fill = $("ctx-fill");
    fill.style.width = barPct + "%";
    fill.classList.toggle("warn", barPct >= 75 && barPct < 92);
    fill.classList.toggle("danger", barPct >= 92);
    $("ctx-text").textContent = "🧠 " + fmtTokens(used) + " / " + fmtTokens(budget) + " · " + pct + "%";
    el.classList.add("visible");
    el.title =
      "Контекст модели: занято " + used.toLocaleString("ru-RU") + " из " + budget.toLocaleString("ru-RU") +
      " токенов (" + pct + "%). Это история переписки и схема инструментов; оценка приблизительная (по символам), а не точный счёт токенов модели." +
      (pct > 100
        ? " Сейчас занято БОЛЬШЕ бюджета: текущий шаг (твоё сообщение и результаты инструментов) не сжимается и уходит целиком. Перед следующим запросом история снова обрезается до бюджета, а при переполнении старая часть сворачивается в памятку."
        : " При заполнении старая часть автоматически сжимается в памятку.");
  }

  // 🧠 Память диалогов: включена ли и сколько памяток уже сохранено.
  async function renderMemoryStatus() {
    const el = $("memory-status");
    if (!el) return;
    const dirEl = $("memory-dir");
    const on = !!(($("s-context-memory") || {}).checked);
    if (!on) {
      el.textContent = "Выключено: сжатые памятки на диск не пишутся. Включи галочку — и агент сможет вспоминать прошлые сессии по датам.";
      if (dirEl) dirEl.textContent = "—";
      return;
    }
    if (!isElectron || !api.memoryStats) {
      el.textContent = "Память диалогов работает в desktop-приложении (в веб-превью недоступна).";
      return;
    }
    try {
      const r = await api.memoryStats();
      if (dirEl && r && r.dir) dirEl.textContent = r.dir;
      if (!r || !r.days) {
        el.textContent = "Памяток пока нет — они появятся, когда контекст переполнится и старые шаги свернутся в памятку.";
        return;
      }
      const kb = r.bytes ? " · " + (r.bytes / 1024).toFixed(0) + " КБ" : "";
      el.textContent = "Сохранено дней: " + r.days + " · памяток: " + r.memos + kb + (r.newest ? " · последняя запись " + r.newest : "") + " · храним " + (r.keepDays || 30) + " дн.";
    } catch {
      el.textContent = "Не удалось прочитать состояние памяти диалогов.";
    }
  }

  // Состояние постоянного профиля браузера агента: включён ли и есть ли папка на диске.
  async function renderBrowserProfileInfo() {
    const el = $("browser-profile-info");
    if (!el) return;
    const box = $("s-browser-profile");
    if (box && !box.checked) {
      el.textContent = "Профиль выключен: браузер агента каждый раз стартует «чистым» — вход на сайты придётся повторять.";
      return;
    }
    if (!isElectron || !api.browserProfileInfo) {
      el.textContent = "Постоянный профиль работает в desktop-приложении: куки и входы на сайты сохраняются между запусками.";
      return;
    }
    try {
      const r = await api.browserProfileInfo();
      el.textContent =
        "Профиль: " +
        (r && r.exists ? "папка на диске, сессии сайтов сохраняются" : "пока пуст — заполнится при первом входе на сайт") +
        (r && r.dir ? " · " + r.dir : "");
    } catch {
      el.textContent = "Не удалось прочитать состояние профиля браузера.";
    }
  }

  // Режим «свой Chrome по CDP»: включён ли и подключены ли мы прямо сейчас.
  async function renderBrowserConnectInfo() {
    const el = $("browser-connect-info");
    if (!el) return;
    const box = $("s-browser-connect");
    if (box && !box.checked) {
      el.textContent = "Режим выключен: агент работает в отдельном окне Chromium (постоянный профиль выше).";
      return;
    }
    if (!isElectron || !api.browserConnectInfo) {
      el.textContent = "Подключение к своему Chrome работает в desktop-приложении.";
      return;
    }
    try {
      const info = await api.browserConnectInfo();
      el.textContent =
        "Режим включён, порт " +
        ((info && info.port) || 9222) +
        " · " +
        (info && info.active
          ? "подключено: работаем в вашем Chrome"
          : "пока не подключено — нажмите «Подключиться» или попросите агента открыть сайт");
    } catch {
      el.textContent = "Не удалось прочитать состояние подключения.";
    }
  }

  function saveSettingsUI() {
    updateModelNeeded();
    collectSettingsFromUI();
    persistSettings();
    updateBadge();
    $("settings-overlay").classList.add("hidden");
    refreshProject();
    toast("Настройки сохранены");
  }

  function toggleKey(inputId) {
    const i = $(inputId);
    i.type = i.type === "password" ? "text" : "password";
  }

  function fmtClock(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const pad = (x) => String(x).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function toast(text) {
    const el = document.createElement("div");
    el.textContent = text;
    Object.assign(el.style, {
      position: "fixed",
      bottom: "90px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#1e222c",
      border: "1px solid #3a4050",
      color: "#e7e9ee",
      padding: "10px 16px",
      borderRadius: "10px",
      zIndex: 200,
      fontSize: "13.5px",
      boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ─────────────── События ───────────────
  // Чтение scrollHeight заставляет браузер синхронно пересчитать раскладку.
  // При быстрой печати (в ленте к этому моменту уже тысячи узлов) это заметно
  // «съедало» плавность — поэтому пересчёт откладываем до кадра.
  let inputResizeRaf = 0;
  function autoResize() {
    if (inputResizeRaf) return;
    inputResizeRaf = requestAnimationFrame(() => {
      inputResizeRaf = 0;
      const t = $("input");
      if (!t) return;
      t.style.height = "auto";
      t.style.height = Math.min(t.scrollHeight, 160) + "px";
    });
  }

  $("btn-send").onclick = sendMessage;
  $("btn-stop").onclick = stop;
  $("btn-plan").onclick = () => {
    if (streaming) return;
    planToggleOn = !planToggleOn;
    $("btn-plan").classList.toggle("active", planToggleOn);
    if (planToggleOn) toast("📋 Режим плана: сначала план и подтверждение, потом действия");
  };
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  $("input").addEventListener("input", autoResize);
  $("input").addEventListener("paste", onInputPaste);
  $("btn-attach-remove").onclick = hideAttachBar;
  $("chat-title").addEventListener("dblclick", startRenameChat);
  $("btn-new-chat").onclick = () => {
    if (!streaming) createChat();
  };
  $("btn-continue-chat").onclick = () => {
    if (streaming) return;
    const prev = getActiveChat();
    if (!prev || !prev.messages.length) { createChat(); return; }
    // Берём последний ответ агента как контекст
    let lastAssistant = "";
    for (let i = prev.messages.length - 1; i >= 0; i--) {
      const m = prev.messages[i];
      if (m && m.role === "assistant" && m.content) {
        const t = typeof m.content === "string" ? m.content : (m.content || []).filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
        if (t.trim()) { lastAssistant = t.trim(); break; }
      }
    }
    // Плюс заголовок/тему предыдущего чата
    const title = prev.title || "";
    const ctx = "ПРОДОЛЖЕНИЕ ПРЕДЫДУЩЕГО ЧАТА\n" + (title ? "Тема/задача: " + title + "\n" : "") + (lastAssistant ? "\nПоследний ответ агента:\n" + lastAssistant.slice(0, 3000) : "\n(Предыдущий чат был пуст)");
    createChat({ contextMsg: ctx, title: title ? title + " (продолжение)" : "Новый чат" });
  };
  // ── Yandex Cloud (дашборд + настройки) ──
  const YC_CREATABLE = ["ydb", "lockbox", "containerRegistry", "storage", "dns", "serverlessContainers", "vpc"];
  const YC_FORMS = {
    apiGateway: ["шлюз", "шлюза", "шлюзов"],
    certificateManager: ["сертификат", "сертификата", "сертификатов"],
    cdn: ["ресурс", "ресурса", "ресурсов"],
    dns: ["зона", "зоны", "зон"],
    logging: ["группа", "группы", "групп"],
    postbox: ["адрес", "адреса", "адресов"],
    containerRegistry: ["реестр", "реестра", "реестров"],
    iam: ["сервисный аккаунт", "сервисных аккаунта", "сервисных аккаунтов"],
    lockbox: ["секрет", "секрета", "секретов"],
    ydb: ["база", "базы", "баз"],
    storage: ["бакет", "бакета", "бакетов"],
    serverlessContainers: ["контейнер", "контейнера", "контейнеров"],
    vpc: ["сеть", "сети", "сетей"],
  };
  let ycStatusCache = null;
  let ycServicesCache = null;
  let ycDashKey = ""; // ключ развёрнутой карточки дашборда
  let ycTotal = null; // всего ресурсов в каталоге («Облако в цифрах»)
  let ycActiveServices = null; // сервисов с ресурсами

  function ycNounPlural(key, n) {
    const forms = YC_FORMS[key] || ["ресурс", "ресурса", "ресурсов"];
    const n10 = n % 10;
    const n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return n + " " + forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return n + " " + forms[1];
    return n + " " + forms[2];
  }

  async function ycRefreshSettingsUI() {
    if (!isElectron) {
      // веб-превью: управление облаком живёт в main-процессе Electron
      const m = $("yc-settings-msg");
      if (m) m.textContent = "⚠️ Управление Yandex Cloud работает в desktop-приложении (на ПК): здесь можно только посмотреть поля настроек.";
      return;
    }
    const msg = $("yc-settings-msg");
    try {
      const st = await api.ycStatus();
      ycStatusCache = st;
      // Держим локальный объект настроек синхронным: иначе устаревший ycFolderId
      // из формы мог бы затереть только что выбранный каталог при «Сохранить».
      if (st) {
        if (st.folderId !== undefined) settings.ycFolderId = st.folderId;
        if (st.folderName !== undefined) settings.ycFolderName = st.folderName;
        if (st.cloudId !== undefined) settings.ycCloudId = st.cloudId;
      }
      const acc = $("yc-conn-account");
      if (st.loggedIn && st.iamOk) {
        $("yc-conn-status").textContent = "✅ Подключено" + (st.folderName ? " · каталог «" + st.folderName + "»" : "");
        $("yc-conn-status").classList.add("ok");
        ycSetHeaderDot(st.folderId ? "ok" : "warn");
        if (acc) {
          acc.textContent = "Аккаунт: " + ((st.clouds && st.clouds[0] && st.clouds[0].name) || "Yandex") + " · облако: " + (st.cloudId || "—");
          acc.classList.remove("hidden");
        }
        $("yc-token-row").classList.add("hidden");
        $("yc-folder-field").classList.remove("hidden");
        $("yc-perms").classList.remove("hidden");
        const sel = $("s-yc-folder");
        sel.innerHTML = "";
        for (const f of st.folders || []) {
          const o = document.createElement("option");
          o.value = f.id;
          o.textContent = f.name || f.id;
          sel.appendChild(o);
        }
        if (!(st.folders || []).length) {
          const o = document.createElement("option");
          o.value = "";
          o.textContent =
            "⚠️ Каталоги не загрузились" + (st.error ? " — " + String(st.error).slice(0, 80) : "") + " (нажми ↻)";
          sel.appendChild(o);
        }
        if (st.folderId) sel.value = st.folderId;
        $("s-yc-allow-create").checked = !!st.allowCreate;
        $("s-yc-allow-delete").checked = !!st.allowDelete;
        // Встроенный yc CLI: показываем, стоит ли он (и где) — настройка живёт в папке приложения.
        if (isElectron && api.ycCliStatus) {
          api.ycCliStatus()
            .then((cl) => {
              const el = $("yc-cli-status");
              if (el) el.textContent = cl && cl.installed ? "встроен: " + cl.path : "не установлен";
            })
            .catch(() => {});
        }
      } else {
        $("yc-conn-status").textContent = "Не подключено" + (st.error ? " — " + st.error : "");
        $("yc-conn-status").classList.remove("ok");
        ycSetHeaderDot("off");
        if (acc) acc.classList.add("hidden");
        $("yc-token-row").classList.remove("hidden");
        $("yc-folder-field").classList.add("hidden");
        $("yc-perms").classList.add("hidden");
      }
      if (msg) msg.textContent = "";
    } catch (e) {
      if (msg) msg.textContent = "Ошибка: " + ((e && e.message) || String(e));
    }
  }

  // Экран-подсказка, когда дашборд не может показать ресурсы (нет токена / веб-версия)
  function ycShowOnboard(icon, title, text) {
    const box = $("yc-dash");
    if (box) box.innerHTML = "";
    const sum = $("yc-summary");
    if (sum) sum.classList.add("hidden");
    ycSetHeaderDot("off");
    const onboard = $("yc-onboard");
    if (!onboard) return;
    const ic = onboard.querySelector(".yc-onboard-ic");
    const t = onboard.querySelector(".yc-onboard-title");
    const x = onboard.querySelector(".yc-onboard-text");
    if (ic && icon) ic.textContent = icon;
    if (t && title) t.textContent = title;
    if (x && text) x.textContent = text;
    onboard.classList.remove("hidden");
  }

  function ycHideOnboard() {
    const onboard = $("yc-onboard");
    if (onboard) onboard.classList.add("hidden");
  }

  async function ycLoadDashboard(force) {
    const statusEl = $("yc-dash-status");
    const box = $("yc-dash");
    if (!statusEl || !box) return;
    if (!isElectron) {
      statusEl.textContent = "Только в desktop-приложении";
      ycShowOnboard(
        "🖥",
        "Дашборд доступен в приложении на ПК",
        "Ресурсы Yandex Cloud, деплой и управление из чата работают в desktop-приложении (Windows/macOS/Linux). В веб-превью доступны только настройки: токен, каталог и разрешения агента."
      );
      return;
    }
    if (!ycStatusCache) {
      try {
        ycStatusCache = await api.ycStatus();
      } catch (e) {
        ycStatusCache = { error: (e && e.message) || String(e) };
      }
    }
    const st = ycStatusCache || {};
    if (!st.loggedIn) {
      statusEl.textContent = "🔑 Не подключено";
      ycShowOnboard(
        "☁️",
        "Yandex Cloud не подключён",
        "Подключи OAuth-токен Yandex — и здесь появится живой дашборд: базы YDB, бакеты Object Storage, реестр образов, Serverless-контейнеры, DNS-зоны, секреты Lockbox, API-шлюз и CDN. Агент сможет управлять ресурсами прямо из чата."
      );
      return;
    }
    ycHideOnboard();
    ycSetHeaderDot(st.iamOk === false ? "warn" : "ok");
    statusEl.textContent = "Каталог: " + (st.folderName || st.folderId || "—") + (st.iamOk === false ? " · ⚠️ " + (st.error || "") : "");
    if (!force && ycServicesCache) {
      ycRenderDash();
      return;
    }
    box.innerHTML = '<div class="yc-loading">Загрузка ресурсов…</div>';
    let r;
    try {
      r = await api.ycResources();
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    if (!r || !r.ok) {
      statusEl.textContent = "⚠️ " + ((r && r.error) || "Ошибка загрузки");
      box.innerHTML = "";
      return;
    }
    ycServicesCache = r.services;
    ycTotal = r.total != null ? r.total : null;
    ycActiveServices = r.activeServices != null ? r.activeServices : null;
    ycRenderDash();
  }

  function ycRenderSummary(total, active) {
    const sum = $("yc-summary");
    if (!sum) return;
    sum.classList.remove("hidden");
    sum.innerHTML = "";
    const mk = (text) => {
      const s = document.createElement("span");
      s.className = "yc-summary-item";
      s.textContent = text;
      return s;
    };
    sum.appendChild(mk("🧮 Ресурсов: " + (total == null ? "—" : total)));
    sum.appendChild(mk("Сервисов с ресурсами: " + (active == null ? "—" : active)));
    const failed = (ycServicesCache || []).filter((s) => !s.ok);
    if (failed.length) {
      sum.appendChild(mk("⚠️ Не ответили: " + failed.length + " — " + failed.map((s) => s.title).slice(0, 3).join(", ")));
    }
  }

  function ycRenderDash() {
    const box = $("yc-dash");
    if (!box) return;
    box.innerHTML = "";
    ycRenderSummary(ycTotal, ycActiveServices);
    const svcs = ycServicesCache || [];
    const grid = document.createElement("div");
    grid.className = "yc-grid";
    for (const s of svcs) {
      const card = document.createElement("div");
      card.className = "yc-card" + (ycDashKey === s.key ? " open" : "");
      card.title = s.ok ? "Клик — список ресурсов" : (s.error ? s.error : "API недоступно");
      const head = document.createElement("div");
      head.className = "yc-card-head";
      const icon = document.createElement("span");
      icon.className = "yc-card-icon";
      icon.textContent = s.icon || "☁️";
      const title = document.createElement("span");
      title.className = "yc-card-title";
      title.textContent = s.title;
      head.appendChild(icon);
      head.appendChild(title);
      const body = document.createElement("div");
      body.className = "yc-card-body";
      const count = document.createElement("div");
      count.className = "yc-card-count" + (s.ok ? "" : " err");
      count.textContent = s.ok ? ycNounPlural(s.key, s.count) : "⚠ ошибка API";
      body.appendChild(count);
      if (!s.ok) {
        const err = document.createElement("div");
        err.className = "yc-card-err";
        err.textContent = String(s.error || "API недоступно").slice(0, 200);
        body.appendChild(err);
      }
      if (s.ok && YC_CREATABLE.includes(s.key)) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "btn btn-small yc-add";
        add.textContent = "＋ Создать";
        add.title = "Создать новый ресурс («" + s.title + "»). Может быть платным.";
        add.onclick = (e) => {
          e.stopPropagation();
          ycCreateFlow(s.key, s.title);
        };
        body.appendChild(add);
      }
      card.appendChild(head);
      card.appendChild(body);
      if (ycDashKey === s.key) {
        const list = document.createElement("div");
        list.className = "yc-card-list";
        if (!s.ok) {
          list.textContent = "Ошибка API: " + (s.error || "недоступно");
        } else if (!s.items || !s.items.length) {
          list.textContent = "Ресурсов нет — нажми «＋ Создать».";
        } else {
          for (const it of s.items.slice(0, 50)) {
            const row = document.createElement("div");
            row.className = "yc-item";
            const nm = document.createElement("span");
            nm.className = "yc-item-name";
            nm.textContent = it.name || it.id || "—";
            nm.title = it.id || "";
            row.appendChild(nm);
            const actions = document.createElement("div");
            actions.className = "yc-item-actions";
            if (s.key === "serverlessContainers" && it.status) {
              const st = document.createElement("span");
              st.className = "yc-status " + String(it.status).toLowerCase();
              st.textContent = it.status;
              actions.appendChild(st);
            }
            if (s.key === "serverlessContainers" && it.url) {
              const go = document.createElement("button");
              go.type = "button";
              go.className = "btn btn-ghost btn-small";
              go.textContent = "↗";
              go.title = "Открыть URL контейнера: " + it.url;
              go.onclick = (e) => {
                e.stopPropagation();
                if (isElectron) api.openExternal(it.url);
              };
              actions.appendChild(go);
            }
            if (s.key === "serverlessContainers") {
              const lg = document.createElement("button");
              lg.type = "button";
              lg.className = "btn btn-ghost btn-small";
              lg.textContent = "📜";
              lg.title = "Логи контейнера (нужен yc CLI)";
              lg.onclick = async (e) => {
                e.stopPropagation();
                let r;
                try {
                  r = await api.ycLogs(s.key, it.id);
                } catch (err) {
                  r = { ok: false, error: (err && err.message) || String(err) };
                }
                if (r && r.ok && r.logs && r.logs.length) {
                  toast("📜 Логи: " + r.logs.length + " записей — открыты в консоли приложения");
                  termAppend("📜 Логи контейнера:\n" + r.logs.slice(-30).join("\n"));
                } else {
                  toast("❌ " + ((r && r.error) || "Логов нет за последние 3 часа"));
                }
              };
              actions.appendChild(lg);
            }
            const del = document.createElement("button");
            del.type = "button";
            del.className = "btn btn-danger btn-small";
            del.textContent = "🗑";
            del.title = "Удалить «" + (it.name || it.id) + "» (необратимо)";
            del.onclick = (e) => {
              e.stopPropagation();
              ycDeleteFlow(s.key, s.title, it);
            };
            actions.appendChild(del);
            row.appendChild(actions);
            list.appendChild(row);
          }
          if (s.items.length > 50) {
            const more = document.createElement("div");
            more.className = "yc-item-more";
            more.textContent = "… и ещё " + (s.items.length - 50);
            list.appendChild(more);
          }
        }
        card.appendChild(list);
      }
      card.onclick = () => {
        ycDashKey = ycDashKey === s.key ? "" : s.key;
        ycRenderDash();
      };
      grid.appendChild(card);
    }
    box.appendChild(grid);
  }

  function ycCreateFlow(serviceKey, title) {
    inputDialog("＋ Создать: " + title, "Имя: латиница, цифры, дефис (2–63 символа). Создание может быть платным.", "Создать").then(async (name) => {
      if (!name) return;
      let r;
      try {
        r = await api.ycCreate(serviceKey, name);
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
      if (r && r.ok) {
        toast("✅ " + r.message);
        ycServicesCache = null;
        ycLoadDashboard(true);
      } else {
        toast("❌ " + ((r && r.error) || "Ошибка создания"));
      }
    });
  }

  function ycDeleteFlow(serviceKey, title, item) {
    confirmModal("🗑 Удалить «" + (item.name || item.id) + "»?", title + ": удаление необратимо и может стереть данные. Продолжить?", async () => {
      let r;
      try {
        r = await api.ycDelete(serviceKey, item.id);
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
      if (r && r.ok) {
        toast("✅ " + r.message);
        ycServicesCache = null;
        ycLoadDashboard(true);
      } else {
        toast("❌ " + ((r && r.error) || "Ошибка удаления"));
      }
    }, true);
  }

  // Обработчики Yandex Cloud
  $("btn-yc-connect").onclick = async () => {
    const t = $("s-yc-token").value.trim();
    if (!t) {
      toast("Вставь OAuth-токен (кнопка «🔑 Получить токен»)");
      return;
    }
    $("btn-yc-connect").disabled = true;
    let r;
    try {
      r = await api.ycSetToken(t);
    } catch (e) {
      r = { ok: false, error: (e && e.message) || String(e) };
    }
    $("btn-yc-connect").disabled = false;
    if (r && r.ok) {
      toast("✅ Подключено к Yandex Cloud" + (r.folderName ? " · каталог «" + r.folderName + "»" : ""));
      ycStatusCache = null;
      ycServicesCache = null;
      ycRefreshSettingsUI();
      ycLoadDashboard(true);
    } else {
      toast("❌ " + ((r && r.error) || "Не удалось войти"));
    }
  };
  function ycTokenUrl() {
    return (ycStatusCache && ycStatusCache.oauthUrl) || "https://oauth.yandex.ru/authorize?response_type=token&client_id=1a6990aa636648e9b2ef855fa7bec2fb";
  }
  function ycOpenTokenPage() {
    const url = ycTokenUrl();
    if (isElectron) api.openExternal(url);
    else window.open(url, "_blank");
  }
  // Точка у кнопки «☁️» в шапке: зелёная — подключено, жёлтая — нужен каталог/IAM
  function ycSetHeaderDot(state) {
    const d = $("btn-toggle-cloud-dot");
    if (d) d.className = "hd-dot" + (state === "ok" ? " ok" : state === "warn" ? " warn" : "");
    const b = $("btn-toggle-cloud");
    if (b) {
      b.title =
        state === "ok"
          ? "Yandex Cloud подключён — ресурсы каталога и деплой"
          : state === "warn"
            ? "Yandex Cloud: проверь каталог или токен"
            : "Yandex Cloud — ресурсы каталога и деплой";
    }
  }
  $("btn-yc-get-token").onclick = ycOpenTokenPage;
  $("btn-yc-logout").onclick = () => {
    confirmModal("Выйти из Yandex Cloud?", "OAuth-токен будет удалён из приложения. Ресурсы в облаке не пострадают.", async () => {
      await api.ycLogout();
      ycStatusCache = null;
      ycServicesCache = null;
      ycRefreshSettingsUI();
      ycLoadDashboard(true);
      toast("Выход выполнен");
    });
  };
  $("btn-yc-refresh-folders").onclick = async () => {
    const sel0 = $("s-yc-folder");
    if (sel0) sel0.innerHTML = '<option value="">⏳ Загрузка каталогов…</option>';
    const r = await api.ycFolders();
    if (!r || !r.ok) {
      const msg = (r && r.error) || "Не удалось загрузить каталоги";
      // Раньше список просто оставался пустым (и «висел» без объяснения причины).
      if (sel0) sel0.innerHTML = '<option value="">⚠️ ' + String(msg).slice(0, 120) + ' — повтори ↻</option>';
      toast("❌ " + msg);
      return;
    }
    const sel = $("s-yc-folder");
    sel.innerHTML = "";
    for (const f of r.folders || []) {
      const o = document.createElement("option");
      o.value = f.id;
      o.textContent = f.name || f.id;
      sel.appendChild(o);
    }
    if (ycStatusCache && ycStatusCache.folderId) sel.value = ycStatusCache.folderId;
    toast("Каталогов: " + ((r.folders || []).length));
  };
  $("s-yc-folder").onchange = () => {
    const sel = $("s-yc-folder");
    const f = (ycStatusCache && ycStatusCache.folders || []).find((x) => x.id === sel.value);
    api.ycSetFolder(sel.value, (f && f.name) || sel.value, (f && f.cloudId) || (ycStatusCache && ycStatusCache.cloudId) || "");
    // Каталог сохранён в main — отражаем это и в локальном объекте настроек.
    settings.ycFolderId = sel.value;
    settings.ycFolderName = (f && f.name) || sel.value;
    settings.ycCloudId = (f && f.cloudId) || (ycStatusCache && ycStatusCache.cloudId) || "";
    ycStatusCache = null;
    ycServicesCache = null;
    toast("Каталог: " + (f && f.name ? f.name : sel.value));
    ycLoadDashboard(true);
  };
  $("s-yc-allow-create").onchange = () => {
    api.ycSetPermissions($("s-yc-allow-create").checked, $("s-yc-allow-delete").checked);
    toast($("s-yc-allow-create").checked ? "Агенту разрешено создавать ресурсы" : "Создание агентом выключено");
  };
  $("s-yc-allow-delete").onchange = () => {
    api.ycSetPermissions($("s-yc-allow-create").checked, $("s-yc-allow-delete").checked);
    toast($("s-yc-allow-delete").checked ? "Агенту разрешено удалять ресурсы" : "Удаление агентом выключено");
  };
  if ($("btn-yc-install-cli")) {
    $("btn-yc-install-cli").onclick = async () => {
      if (!isElectron || !api.ycInstallCli) {
        toast("yc CLI ставится в desktop-приложении");
        return;
      }
      const btn = $("btn-yc-install-cli");
      const stEl = $("yc-cli-status");
      btn.disabled = true;
      if (stEl) stEl.textContent = "скачиваю официальный yc CLI…";
      try {
        const r = await api.ycInstallCli();
        if (r && r.ok) {
          if (stEl) stEl.textContent = "встроен: " + (r.path || "");
          toast(r.already ? "yc CLI уже установлен" : "✅ yc CLI установлен" + (r.version ? " (версия " + r.version + ")" : ""));
        } else {
          if (stEl) stEl.textContent = "не установлен";
          toast("❌ " + ((r && r.error) || "не удалось установить yc CLI"));
        }
      } catch (e) {
        if (stEl) stEl.textContent = "не установлен";
        toast("❌ " + ((e && e.message) || String(e)));
      }
      btn.disabled = false;
    };
  }
  $("btn-yc-dash-refresh").onclick = () => {
    ycServicesCache = null;
    ycLoadDashboard(true);
  };
  $("btn-yc-dash-settings").onclick = () => {
    openSettings();
    showSettingsTab("yandex");
  };
  // Кнопка «☁️» в шапке — дашборд Yandex Cloud в правой панели
  if ($("btn-toggle-cloud")) {
    $("btn-toggle-cloud").onclick = () => {
      if (sidePanelVisible() && sideTab === "cloud") closeSidePanel();
      else openSidePanel("cloud");
    };
  }
  // Из настроек — сразу открыть дашборд
  if ($("btn-yc-open-dash")) {
    $("btn-yc-open-dash").onclick = () => {
      $("settings-overlay").classList.add("hidden");
      openSidePanel("cloud");
    };
  }
  if ($("btn-yc-onboard-settings")) {
    $("btn-yc-onboard-settings").onclick = () => {
      openSettings();
      showSettingsTab("yandex");
    };
  }
  if ($("btn-yc-onboard-token")) $("btn-yc-onboard-token").onclick = ycOpenTokenPage;
  $("btn-yc-paste-token").onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t && t.trim()) {
        $("s-yc-token").value = t.trim();
        toast("Токен вставлен из буфера — нажми «Войти»");
      } else {
        toast("Буфер обмена пуст");
      }
    } catch (e) {
      toast("Не удалось прочитать буфер: " + ((e && e.message) || String(e)));
    }
  };
  $("btn-yc-deploy").onclick = () => {
    if (!isElectron) {
      toast("Деплой доступен в desktop-приложении");
      return;
    }
    const dir = settings.workingDir || "";
    if (!dir) {
      toast("Сначала выбери рабочую директорию (Настройки → 📁 Проект и GitHub)");
      return;
    }
    inputDialog("🚀 Деплой на Yandex Cloud", "Папка: " + dir + "\nИмя приложения (латиница, 2–63 символа). Docker должен быть установлен и запущен.", "Задеплоить").then(async (name) => {
      if (!name) return;
      const box = $("yc-deploy-box");
      const stepsEl = $("yc-deploy-steps");
      const resultEl = $("yc-deploy-result");
      box.classList.remove("hidden");
      stepsEl.innerHTML = "";
      resultEl.classList.add("hidden");
      stepsEl.innerHTML = '<div class="yc-loading">⏳ Деплой… (docker build может занять несколько минут)</div>';
      let r;
      try {
        r = await api.ycDeploy(dir, name, {});
      } catch (e) {
        r = { ok: false, error: (e && e.message) || String(e) };
      }
      stepsEl.innerHTML = "";
      for (const s of (r && r.steps) || []) {
        const d = document.createElement("div");
        d.className = "yc-step";
        d.textContent = s;
        stepsEl.appendChild(d);
      }
      if (r && r.ok) {
        if (r.url) {
          $("yc-deploy-url").textContent = r.url;
          resultEl.classList.remove("hidden");
        }
        toast("✅ Деплой завершён");
        ycServicesCache = null;
        ycLoadDashboard(true);
      } else {
        const d = document.createElement("div");
        d.className = "yc-step err";
        d.textContent = "❌ " + ((r && r.error) || "Ошибка деплоя");
        stepsEl.appendChild(d);
      }
    });
  };
  $("btn-yc-deploy-open").onclick = () => {
    const u = $("yc-deploy-url").textContent.trim();
    if (u && isElectron) api.openExternal(u);
  };

  $("btn-settings").onclick = openSettings;
  $("model-badge").onclick = toggleModelPopup;
  $("mp-close").onclick = closeModelPopup;
  $("mp-refresh").onclick = refreshModelsQuick;
  $("mp-settings").onclick = () => {
    closeModelPopup();
    openSettings();
  };
  document.addEventListener("mousedown", (e) => {
    const popup = $("model-popup");
    if (popup.classList.contains("hidden")) return;
    if (!popup.contains(e.target) && e.target !== $("model-badge")) closeModelPopup();
  });
  $("btn-model-needed").onclick = openSettings;

  // Быстрые действия на приветственном экране (делегирование — работает даже
  // после пересоздания чипов при смене чата)
  const welcome = $("welcome");
  welcome.addEventListener("click", (e) => {
    const chip = e.target.closest(".welcome-chips .chip");
    if (!chip || !chip.dataset.prompt) return;
    $("input").value = chip.dataset.prompt;
    autoResize();
    sendMessage();
  });

  // Поиск по чатам. В поле поиска может оказаться «мусор» от автозаполнения браузера —
  // адреса из настроек (https://api.groq.com/openai/v1, localhost:11434, email и т.п.).
  // Такой «адрес» не может быть поисковым запросом: он не должен прятать все чаты
  // и не должен мозолить глаза под кнопкой «Новый чат».
  function isJunkSearchValue(v) {
    const s = String(v || "").trim();
    if (!s) return false;
    if (/^(https?:)?\/\//i.test(s)) return true; // URL со схемой или //
    if (s.includes("@")) return true; // email / токен
    // Домен без схемы, возможно с путём или портом: api.groq.com, groq.com/openai/v1, localhost:11434
    if (/^[\w.-]+(\.[a-zа-яё]{2,})+([/:?#]|$)/i.test(s)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/:?#]|$)/.test(s)) return true; // IP-адрес
    return false;
  }

  function applyChatFilter() {
    const raw = $("chat-search").value.trim();
    if (isJunkSearchValue(raw)) {
      // В поле попал адрес, а не запрос: показываем все чаты и стираем «адрес»
      $("chat-search").value = "";
      document.querySelectorAll(".chat-item").forEach((it) => (it.style.display = ""));
      return;
    }
    const q = raw.toLowerCase();
    document.querySelectorAll(".chat-item").forEach((it) => {
      const t = it.querySelector(".chat-title");
      it.style.display = !q || (t && t.textContent.toLowerCase().includes(q)) ? "" : "none";
    });
  }
  $("chat-search").addEventListener("input", applyChatFilter);
  // Автозаполнение браузера подставляло сюда URL из настроек — при фокусе чистим;
  // иначе просто выделяем текст, чтобы печать заменила его.
  $("chat-search").addEventListener("focus", () => {
    if (isJunkSearchValue($("chat-search").value)) {
      $("chat-search").value = "";
      applyChatFilter();
    } else {
      $("chat-search").select();
    }
  });

  // Горячие клавиши: Ctrl/Cmd+N — новый чат
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      if (!streaming) createChat();
    }
  });
  $("btn-close-settings").onclick = () => $("settings-overlay").classList.add("hidden");
  $("settings-overlay").addEventListener("click", (e) => {
    if (e.target === $("settings-overlay")) $("settings-overlay").classList.add("hidden");
  });
  $("btn-toggle-key").onclick = () => toggleKey("s-openai-key");
  $("btn-toggle-anth-key").onclick = () => toggleKey("s-anth-key");
  const provSel = $("s-provider-select");
  if (provSel) {
    provSel.onchange = () => setProviderUI(provSel.value);
  }
  // Вкладки настроек
  document.querySelectorAll(".stab").forEach((b) => {
    b.onclick = () => showSettingsTab(b.dataset.tab);
  });
  // Аккордеон: карточки провайдеров — клик по свёрнутой выбирает провайдера и раскрывает,
  // по раскрытой — сворачивает; вложенные блоки (data-acc-head="presets") — просто раскрытие.
  document.querySelectorAll("[data-acc-head]").forEach((h) => {
    h.onclick = () => {
      const acc = h.closest(".acc");
      const isProvider = acc.dataset.acc === "ollama" || acc.dataset.acc === "openai" || acc.dataset.acc === "anthropic";
      if (isProvider) {
        if (acc.classList.contains("open")) {
          acc.classList.remove("open");
        } else {
          setProviderUI(acc.dataset.acc);
        }
      } else {
        acc.classList.toggle("open");
      }
    };
  });
  document.querySelectorAll(".chip[data-preset]").forEach((b) => {
    b.onclick = () => setPreset(b.dataset.preset);
  });
  $("btn-refresh-models").onclick = () => {
    collectSettingsFromUI();
    persistSettings();
    loadModels();
  };
  $("btn-refresh-anth-models").onclick = () => {
    collectSettingsFromUI();
    persistSettings();
    loadModels();
  };
  $("btn-refresh-ollama-models").onclick = () => {
    collectSettingsFromUI();
    persistSettings();
    loadModels();
  };
  $("btn-test").onclick = () => {
    collectSettingsFromUI();
    persistSettings();
    testConnection();
  };
  $("btn-save-settings").onclick = saveSettingsUI;
  // Сохранённые OpenAI-подключения: список, сохранить/обновить, удалить
  $("s-openai-profile").onchange = () => {
    const v = $("s-openai-profile").value;
    if (v === "__new__") { settings.openaiActiveProfile = ""; return; }
    applyOpenaiProfile(v);
  };
  $("btn-profile-save").onclick = saveOpenaiProfileFromFields;
  $("btn-profile-delete").onclick = deleteOpenaiProfile;
  $("btn-pick-dir").onclick = async () => {
    if (!isElectron) {
      toast("Выбор папки доступен только в приложении на ПК");
      return;
    }
    const p = await api.pickDirectory();
    if (p) $("s-workdir").value = p;
  };

  // Браузер агента: постоянный профиль (сессии сайтов) — очистка и обновление подписи
  if ($("btn-browser-profile-clear")) {
    $("btn-browser-profile-clear").onclick = async () => {
      if (!isElectron || !api.browserClearProfile) {
        toast("Очистка профиля доступна в desktop-приложении");
        return;
      }
      if (!confirm("Выйти со всех сайтов в браузере агента? Куки и сессии будут стёрты — при следующем входе потребуется авторизация заново.")) return;
      const r = await api.browserClearProfile();
      toast((r && r.message) || "Профиль очищен");
      renderBrowserProfileInfo();
    };
  }
  if ($("s-browser-profile")) $("s-browser-profile").onchange = renderBrowserProfileInfo;

  // «Свой Chrome» (CDP): подключение по кнопке и подпись состояния.
  if ($("s-browser-connect")) $("s-browser-connect").onchange = renderBrowserConnectInfo;
  if ($("s-browser-connect-port")) $("s-browser-connect-port").onchange = renderBrowserConnectInfo;
  if ($("btn-browser-connect")) {
    $("btn-browser-connect").onclick = async () => {
      if (!isElectron || !api.browserConnect) {
        toast("Подключение к своему Chrome доступно в desktop-приложении");
        return;
      }
      const el = $("browser-connect-info");
      if (el) el.textContent = "⏳ Подключаюсь к Chrome… (если он не запущен с отладкой, приложение запустит его само)";
      const port = parseInt($("s-browser-connect-port").value, 10) || 9222;
      const r = await api.browserConnect({ port });
      const msg = (r && r.message) || "Не удалось подключиться";
      if (el) el.textContent = msg.split("\n").slice(0, 2).join(" ");
      toast(r && r.ok ? "Подключено к вашему Chrome" : "Не подключилось — смотрите подсказку ниже");
      renderBrowserConnectInfo();
    };
  }

  // ─────────────── Панель проекта: файлы + коммиты ───────────────
  let panelTab = "files";
  const selectedChanges = new Set(); // выбранные файлы для массовых операций
  let repoRoot = null;
  let treeGitStatus = null; // rel-путь → "new" | "mod" для подсветки дерева
  const treeLoading = new Set();
  const pathSep = isElectron && navigator.platform && navigator.platform.includes("Win") ? "\\" : "/";

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s == null ? "" : s);
    return d.innerHTML;
  }

  function formatSize(n) {
    if (n == null || n < 0) return "";
    if (n < 1024) return n + " Б";
    if (n < 1048576) return (n / 1024).toFixed(1) + " КБ";
    return (n / 1048576).toFixed(1) + " МБ";
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (x) => String(x).padStart(2, "0");
    return (
      pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
    );
  }

  function toastShort(text) {
    toast(String(text || "").slice(0, 160));
  }

  function togglePanel() {
    if (!isElectron) {
      toast("Панель проекта доступна в приложении на ПК");
      return;
    }
    const panel = $("project-panel");
    const wasHidden = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !wasHidden);
    $("btn-toggle-panel").classList.toggle("active", wasHidden);
    if (wasHidden) {
      refreshProject();
      refreshProjects();
    }
  }

  // Активная директория проекта: если выбран GitHub-репозиторий — работаем в нём,
  // иначе — в рабочей директории.
  function projectDir() {
    // Панель показывает папку последнего склонированного репозитория (кнопка «⬇ Выгрузить»
    // или поле «Клонировать») — даже если рабочая директория недоступна для записи и клон
    // автоматически ушёл в запасную записываемую папку.
    if (isElectron && settings.githubRepoDir) return settings.githubRepoDir;
    return settings.workingDir || "";
  }

  function refreshProject() {
    refreshTree();
    Promise.resolve(refreshRepo())
      .then(updateStatusBar)
      .catch(() => {});
  }

  // ── Проекты (переключатель в панели) ──
  function refreshProjects() {
    const row = $("project-select").closest(".project-switch");
    if (!isElectron) {
      row.classList.add("hidden");
      return;
    }
    row.classList.remove("hidden");
    api.projectsList().then((r) => {
      if (!r || !r.ok) return;
      const sel = $("project-select");
      sel.innerHTML = "";
      if (!r.projects.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "Нет проектов — создай ＋";
        sel.appendChild(o);
        $("btn-project-add").disabled = false;
        $("btn-project-remove").disabled = true;
        return;
      }
      r.projects.forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name + (p.exists ? "" : " ⚠");
        o.title = p.dir;
        if (p.id === r.activeId) o.selected = true;
        sel.appendChild(o);
      });
      $("btn-project-add").disabled = r.projects.length >= 10;
      $("btn-project-remove").disabled = !r.activeId;
      updateStatusBar();
    });
  }

  async function switchProject(id) {
    if (!id) return;
    const r = await api.projectsActivate(id);
    if (!r || !r.ok) {
      toast((r && r.error) || "Не удалось переключить проект");
      refreshProjects();
      return;
    }
    const s = await api.getSettings();
    settings = normalize(s);
    $("s-workdir").value = settings.workingDir || "";
    // Переключаемся на чат, привязанный к этому проекту (или создаём новый).
    ensureProjectChat(id, r.project && r.project.name);
    toast("Проект: " + (r.project && r.project.name));
    refreshProject();
    refreshProjects();
    refreshRepo();
    refreshDevControls();
  }

  // ── Файлы ──
  function fileIcon(name) {
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"].includes(ext)) return "🖼";
    if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "exe", "dmg", "msi", "jar", "apk"].includes(ext)) return "📦";
    if (["md", "txt", "rst"].includes(ext)) return "📝";
    return "📄";
  }

  async function refreshTree() {
    const dir = projectDir();
    $("panel-dir-path").textContent = dir || "Рабочая директория не выбрана";
    $("panel-dir-path").title = dir;
    const tree = $("tree");
    tree.innerHTML = "";
    if (!isElectron || !dir) {
      tree.innerHTML = '<div class="tree-empty">Нажми 📁, чтобы выбрать рабочую папку, или клонируй репозиторий ниже.</div>';
      return;
    }
    // Карта git-статусов (для подсветки новых/изменённых файлов в дереве):
    // rel-путь → "new" (не отслеживается) | "mod" (изменён/в индексе).
    treeGitStatus = {};
    if (isElectron && repoRoot) {
      try {
        const st = await api.gitStatus(repoRoot);
        if (st && st.ok) {
          for (const f of st.untracked) treeGitStatus[f.replace(/\\/g, "/")] = "new";
          for (const f of st.staged) treeGitStatus[f.replace(/\\/g, "/")] = "mod";
          for (const f of st.unstaged) treeGitStatus[f.replace(/\\/g, "/")] = "mod";
        }
      } catch {}
    }
    const node = document.createElement("div");
    node.className = "tree-node";
    const row = document.createElement("div");
    row.className = "tree-row root";
    const caret = document.createElement("span");
    caret.className = "tree-caret";
    caret.textContent = "▾";
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = "🗂";
    const name = document.createElement("span");
    name.className = "tree-name";
    const base = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    name.textContent = base;
    row.title = dir;
    row.appendChild(caret);
    row.appendChild(icon);
    row.appendChild(name);
    const children = document.createElement("div");
    children.className = "tree-children";
    node.appendChild(row);
    node.appendChild(children);
    tree.appendChild(node);
    await loadChildren(node, dir);
  }

  async function loadChildren(nodeEl, dir) {
    const wrap = nodeEl.querySelector(".tree-children");
    if (treeLoading.has(dir)) return;
    treeLoading.add(dir);
    const res = await api.fsListTree(dir);
    treeLoading.delete(dir);
    wrap.innerHTML = "";
    if (!res || !res.ok) {
      wrap.innerHTML = '<div class="tree-empty">' + esc(res && res.error) + "</div>";
      return;
    }
    if (!res.entries.length) {
      wrap.innerHTML = '<div class="tree-empty">Пусто</div>';
      return;
    }
    for (const e of res.entries) wrap.appendChild(buildTreeEntry(e, dir));
    nodeEl.classList.add("open");
  }

  function buildTreeEntry(e, parentDir) {
    const full = parentDir.replace(/[\\/]+$/, "") + pathSep + e.name;
    const node = document.createElement("div");
    node.className = "tree-node";
    const row = document.createElement("div");
    row.className = "tree-row";
    row.title = full;
    const caret = document.createElement("span");
    caret.className = "tree-caret";
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = e.name;
    const children = document.createElement("div");
    children.className = "tree-children";
    const actions = document.createElement("span");
    actions.className = "tree-actions";
    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑";
    delBtn.className = "danger";
    if (e.isDir) {
      caret.textContent = "▸";
      icon.textContent = "📁";
      row.appendChild(caret);
      row.appendChild(icon);
      row.appendChild(name);
      row.classList.add("dir");
      row.dataset.dir = full;
      row.onclick = () => {
        const open = node.classList.contains("open");
        if (!open) {
          caret.textContent = "▾";
          loadChildren(node, full);
        } else {
          caret.textContent = "▸";
          node.classList.remove("open");
          node.querySelector(".tree-children").innerHTML = "";
        }
      };
      delBtn.title = "Удалить папку целиком";
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        deleteFsItem(full, true);
      };
      actions.appendChild(delBtn);
    } else {
      caret.textContent = " ";
      icon.textContent = fileIcon(e.name);
      row.title = full + (e.size != null ? " · " + formatSize(e.size) : "");
      row.classList.add("file");
      row.onclick = () => viewFile(full);
      row.appendChild(caret);
      row.appendChild(icon);
      row.appendChild(name);
      // Подсветка git-статуса: 🆕 новый файл, ✏️ изменённый
      if (treeGitStatus) {
        const rel = full.startsWith(repoRoot + "/") || full.startsWith(repoRoot + "\\")
          ? full.slice(repoRoot.length + 1).replace(/\\/g, "/")
          : null;
        const kind = rel && treeGitStatus[rel];
        if (kind) {
          row.classList.add(kind === "new" ? "tree-new" : "tree-mod");
          const mark = document.createElement("span");
          mark.className = "tree-mark";
          mark.textContent = kind === "new" ? "🆕" : "✏️";
          mark.title = kind === "new" ? "Новый файл (ещё не в git)" : "Изменён относительно последнего коммита";
          row.insertBefore(mark, name.nextSibling);
        }
      }
      const editBtn = document.createElement("button");
      editBtn.textContent = "✎";
      editBtn.title = "Открыть и редактировать";
      editBtn.onclick = (ev) => {
        ev.stopPropagation();
        viewFile(full, { edit: true });
      };
      actions.appendChild(editBtn);
      delBtn.title = "Удалить файл";
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        deleteFsItem(full, false);
      };
      actions.appendChild(delBtn);
    }
    row.appendChild(actions);
    node.appendChild(row);
    node.appendChild(children);
    return node;
  }

  // ═══ Файлы: вкладки, нумерация строк, подсветка синтаксиса ═══
  let fileViewPath = "";   // путь активного файла (для кнопок панели)
  let fileCanEdit = false; // текстовый ли активный файл
  let openFiles = [];      // [{ path, content, orig, loaded, dirty, truncated, binary, image }]
  let editMode = false;    // активная вкладка открыта в редакторе
  let hlInEditor = true;   // подсветка в редакторе (кнопка ✨)
  let editorRepaint = null; // перерисовать слой подсветки в открытом редакторе
  const MAX_VIEW_LINES = 8000;

  function hl(code, name) {
    return window.Highlight && window.Highlight.highlight ? window.Highlight.highlight(code, name) : escHtml(code);
  }

  function activeFile() {
    for (let i = 0; i < openFiles.length; i++) if (openFiles[i].path === fileViewPath) return openFiles[i];
    return null;
  }

  function isImagePath(p) {
    return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(String(p || ""));
  }

  function fileErrorEl(text) {
    const d = document.createElement("div");
    d.className = "file-error";
    d.textContent = text;
    return d;
  }

  function updateFileToolbar() {
    const f = activeFile();
    const img = !!(f && f.image);
    const editBtn = $("btn-file-edit");
    const saveBtn = $("btn-file-save");
    const hlBtn = $("btn-file-hl");
    const delBtn = $("btn-file-delete");
    if (editBtn) editBtn.classList.toggle("hidden", editMode || img || !fileCanEdit);
    if (saveBtn) saveBtn.classList.toggle("hidden", !editMode);
    if (hlBtn) {
      hlBtn.classList.toggle("hidden", !editMode);
      hlBtn.classList.toggle("active", hlInEditor);
    }
    if (delBtn) delBtn.classList.toggle("hidden", !fileViewPath);
  }

  // Открыть файл: новая вкладка или активация уже открытой (opts.edit — сразу редактор)
  async function viewFile(p, opts) {
    opts = opts || {};
    if (!isElectron || !p) return;
    let f = null;
    for (let i = 0; i < openFiles.length; i++) if (openFiles[i].path === p) f = openFiles[i];
    if (!f) {
      f = { path: p, content: "", orig: "", loaded: false, dirty: false, truncated: false, binary: false, image: isImagePath(p) };
      openFiles.push(f);
    }
    fileViewPath = p;
    editMode = !!opts.edit && !f.image;
    $("file-overlay").classList.remove("hidden");
    renderFileTabs();
    await loadActiveFile();
  }

  async function loadActiveFile() {
    const f = activeFile();
    const content = $("file-content");
    if (!f) {
      content.innerHTML = "";
      updateFileToolbar();
      return;
    }
    $("file-path").textContent = f.path;
    $("file-path").title = f.path;
    if (f.image) {
      fileCanEdit = false;
      updateFileToolbar();
      const imgRes = await api.fsReadImage(f.path);
      content.innerHTML = "";
      if (!imgRes || !imgRes.ok) {
        content.appendChild(fileErrorEl((imgRes && imgRes.error) || "Не удалось прочитать изображение"));
        return;
      }
      const img = document.createElement("img");
      img.className = "image-view";
      img.src = imgRes.dataUrl;
      img.alt = f.path;
      content.appendChild(img);
      return;
    }
    // Несохранённые правки не перечитываем с диска — иначе потеряем их
    if (!f.loaded || !f.dirty) {
      const res = await api.fsReadFile(f.path);
      if (!res || !res.ok) {
        f.loaded = true;
        f.content = "";
        f.binary = true;
        f.truncated = false;
        fileCanEdit = false;
        content.innerHTML = "";
        content.appendChild(fileErrorEl((res && res.error) || "Не удалось прочитать файл"));
        updateFileToolbar();
        return;
      }
      f.content = res.content || "";
      f.truncated = !!res.truncated;
      f.binary = !!res.binary;
      f.loaded = true;
      f.orig = f.content;
    }
    fileCanEdit = !f.truncated && !f.binary;
    updateFileToolbar();
    if (editMode && fileCanEdit) renderFileEditor(f.content);
    else renderFileView(f);
  }

  // ── Чтение: нумерация строк + подсветка ──
  function renderFileView(f) {
    editorRepaint = null;
    const content = $("file-content");
    content.innerHTML = "";
    const lines = String(f.content || "").split("\n");
    const shown = lines.slice(0, MAX_VIEW_LINES);
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    const gutter = document.createElement("div");
    gutter.className = "code-gutter";
    for (let i = 0; i < shown.length; i++) {
      const d = document.createElement("div");
      d.className = "code-gn";
      d.textContent = String(i + 1);
      gutter.appendChild(d);
    }
    const pre = document.createElement("pre");
    pre.className = "code-pre";
    pre.innerHTML = hl(shown.join("\n"), f.path);
    wrap.appendChild(gutter);
    wrap.appendChild(pre);
    content.appendChild(wrap);
    if (f.truncated) content.appendChild(fileErrorEl("Файл обрезан — показаны первые 300 КБ."));
  }

  // ── Правка: textarea поверх подсвеченного слоя + нумерация ──
  function renderFileEditor(text) {
    const content = $("file-content");
    content.innerHTML = "";
    const f = activeFile();
    const name = f ? f.path : "";
    const hint = document.createElement("div");
    hint.className = "file-edit-hint";
    hint.textContent = "Редактирование: " + name + " — Ctrl+S сохранить, Tab — отступ, ✨ — подсветка.";
    const wrap = document.createElement("div");
    wrap.className = "code-edit-wrap" + (hlInEditor ? "" : " no-hl");
    const gutter = document.createElement("div");
    gutter.className = "code-edit-gutter";
    const gin = document.createElement("div");
    gutter.appendChild(gin);
    const box = document.createElement("div");
    box.className = "code-edit-box";
    const pre = document.createElement("pre");
    pre.className = "code-hl";
    const ta = document.createElement("textarea");
    ta.className = "code-input";
    ta.id = "file-editor";
    ta.spellcheck = false;
    ta.value = text;
    ta.setAttribute("wrap", "off");
    box.appendChild(pre);
    box.appendChild(ta);
    wrap.appendChild(gutter);
    wrap.appendChild(box);
    content.appendChild(hint);
    content.appendChild(wrap);

    function paintGutter() {
      const n = window.Highlight && window.Highlight.countLines ? window.Highlight.countLines(ta.value) : ta.value.split("\n").length;
      if (gin.childElementCount === n) return;
      gin.innerHTML = "";
      for (let i = 0; i < n; i++) {
        const d = document.createElement("div");
        d.className = "code-egn";
        d.textContent = String(i + 1);
        gin.appendChild(d);
      }
    }
    const LIVE_HL_MAX = 150 * 1024; // живая подсветка — до 150 КБ текста
    let hlWarned = false;
    function paintCode() {
      const tooBig = ta.value.length > LIVE_HL_MAX;
      if (!hlInEditor || tooBig) {
        wrap.classList.add("no-hl"); // текст в textarea прозрачный — показываем его явно
        pre.innerHTML = "";
        if (tooBig && hlInEditor && !hlWarned) {
          hlWarned = true;
          toast("Файл большой — подсветка в редакторе отключена, текст обычный");
        }
        return;
      }
      wrap.classList.remove("no-hl");
      pre.innerHTML = hl(ta.value, name) + "\n";
    }
    function syncScroll() {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
      gin.style.transform = "translateY(" + -ta.scrollTop + "px)";
    }
    // Кнопка ✨ в шапке панели дёргает этот хук
    editorRepaint = function () {
      wrap.classList.toggle("no-hl", !hlInEditor);
      paintCode();
      syncScroll();
    };
    ta.addEventListener("input", () => {
      const cur = activeFile();
      if (cur) {
        cur.content = ta.value;
        cur.dirty = cur.content !== (cur.orig || "");
      }
      renderFileTabs();
      paintGutter();
      paintCode();
      syncScroll();
    });
    ta.addEventListener("scroll", syncScroll);
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveEditedFile();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const s0 = ta.selectionStart;
        const s1 = ta.selectionEnd;
        ta.value = ta.value.slice(0, s0) + "  " + ta.value.slice(s1);
        ta.selectionStart = ta.selectionEnd = s0 + 2;
        ta.dispatchEvent(new Event("input"));
      }
    });
    paintGutter();
    paintCode();
    syncScroll();
    ta.focus();
    try {
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } catch {}
  }

  async function saveEditedFile() {
    const ta = $("file-editor");
    const f = activeFile();
    if (!ta || !f) return;
    const text = ta.value;
    if (text.length > 2 * 1024 * 1024) {
      toast("Файл слишком большой для сохранения из панели (максимум 2 МБ)");
      return;
    }
    const r = await api.fsWriteFile(f.path, text);
    toastShort(r && r.ok ? "✅ Сохранено: " + f.path : "❌ " + ((r && r.error) || "Ошибка сохранения"));
    if (r && r.ok) {
      f.content = text;
      f.orig = text;
      f.dirty = false;
      f.loaded = true;
      f.truncated = false;
      f.binary = false;
      refreshTree();
      renderFileTabs();
      editMode = false;
      renderFileView(f);
      updateFileToolbar();
    }
  }

  // ── Вкладки открытых файлов ──
  function renderFileTabs() {
    const box = $("file-tabs");
    if (!box) return;
    box.innerHTML = "";
    for (let i = 0; i < openFiles.length; i++) {
      const f = openFiles[i];
      const tab = document.createElement("div");
      tab.className = "file-tab" + (f.path === fileViewPath ? " active" : "");
      tab.title = f.path;
      const icon = document.createElement("span");
      icon.textContent = fileIcon(f.path);
      const nm = document.createElement("span");
      nm.className = "file-tab-name";
      nm.textContent = pathBase(f.path);
      tab.appendChild(icon);
      tab.appendChild(nm);
      if (f.dirty) {
        const d = document.createElement("span");
        d.className = "file-tab-dot";
        d.title = "Есть несохранённые правки";
        tab.appendChild(d);
      }
      const x = document.createElement("button");
      x.className = "file-tab-x";
      x.textContent = "✕";
      x.title = "Закрыть вкладку";
      x.onclick = (ev) => {
        ev.stopPropagation();
        closeFileTab(f.path);
      };
      tab.appendChild(x);
      tab.onclick = () => activateFileTab(f.path);
      box.appendChild(tab);
    }
  }

  async function activateFileTab(p) {
    if (p === fileViewPath) return;
    fileViewPath = p;
    editMode = false;
    renderFileTabs();
    await loadActiveFile();
  }

  function closeFileTab(p) {
    const i = openFiles.findIndex((f) => f.path === p);
    if (i < 0) return;
    openFiles.splice(i, 1);
    if (fileViewPath === p) {
      const next = openFiles[i] || openFiles[i - 1] || null;
      fileViewPath = next ? next.path : "";
      editMode = false;
    }
    renderFileTabs();
    if (!fileViewPath) {
      $("file-overlay").classList.add("hidden");
      return;
    }
    loadActiveFile();
  }

  // Закрыть вкладки удалённого файла или папки
  function closeTabsUnder(p) {
    const pref = String(p || "").replace(/[\\/]+$/, "") + "/";
    const rest = openFiles.filter((f) => f.path !== p && f.path.replace(/\\/g, "/").indexOf(pref.replace(/\\/g, "/")) !== 0);
    if (rest.length === openFiles.length) return;
    openFiles = rest;
    if (!activeFile()) fileViewPath = "";
    renderFileTabs();
    if (!fileViewPath) {
      editMode = false;
      $("file-overlay").classList.add("hidden");
    }
  }

  // ── Ручное создание / удаление файлов и папок ──
  let inputResolver = null;

  function inputDialog(title, hintText, okLabel) {
    return new Promise((resolve) => {
      inputResolver = resolve;
      $("input-title").textContent = title;
      $("input-hint").textContent = hintText || "";
      $("input-value").value = "";
      const ok = $("btn-input-ok");
      ok.textContent = okLabel || "Создать";
      $("input-overlay").classList.remove("hidden");
      setTimeout(() => { $("input-value").focus(); }, 30);
    });
  }

  function resolveInput(value) {
    $("input-overlay").classList.add("hidden");
    const cb = inputResolver;
    inputResolver = null;
    if (cb) cb(value);
  }

  // ── Диалог «Новый проект» ──
  let projectChosenDir = "";
  function openProjectDialog() {
    projectChosenDir = "";
    $("project-name").value = "";
    $("project-dir").value = "";
    $("project-hint").textContent = "";
    $("btn-project-ok").disabled = false;
    $("project-overlay").classList.remove("hidden");
    setTimeout(() => { $("project-name").focus(); }, 30);
  }
  function closeProjectDialog() {
    $("project-overlay").classList.add("hidden");
  }

  async function newProjectFile() {
    if (!isElectron) return;
    const dir = projectDir();
    if (!dir) {
      toast("Сначала выбери рабочую директорию (📁)");
      return;
    }
    const name = await inputDialog("Новый файл", "Создаётся в корне: " + dir + " (имя без слэшей)");
    if (!name || !name.trim()) return;
    const r = await api.fsCreateFile(dir, name, "");
    if (!r || !r.ok) {
      toastShort("❌ " + ((r && r.error) || "Не удалось создать файл"));
      return;
    }
    toastShort("✅ Файл создан: " + r.path);
    refreshTree();
    viewFile(r.path, { edit: true });
  }

  async function newProjectFolder() {
    if (!isElectron) return;
    const dir = projectDir();
    if (!dir) {
      toast("Сначала выбери рабочую директорию (📁)");
      return;
    }
    const name = await inputDialog("Новая папка", "Создаётся в корне: " + dir + " (имя без слэшей)");
    if (!name || !name.trim()) return;
    const r = await api.fsCreateFolder(dir, name);
    toastShort(r && r.ok ? "✅ Папка создана: " + r.path : "❌ " + ((r && r.error) || "Не удалось создать папку"));
    if (r && r.ok) refreshTree();
  }

  function pathBase(p) {
    return String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
  }

  function deleteFsItem(p, isDir) {
    const nm = pathBase(p);
    confirmModal(
      "Удалить «" + nm + "»?",
      isDir ? "Папка будет удалена вместе со всем содержимым (рекурсивно). Действие необратимо." : "Файл будет удалён безвозвратно.",
      async () => {
        const r = await api.fsDelete(p);
        toastShort(r && r.ok ? "✅ Удалено: " + nm : "❌ " + ((r && r.error) || "Ошибка удаления"));
        if (r && r.ok) {
          closeTabsUnder(p);
          refreshTree();
        }
      },
      true
    );
  }

  // ── Перетаскивание файлов и изображений в панель проекта ──
  function collectDrop(dt) {
    return new Promise((resolve) => {
      const out = [];
      const queue = [];
      const dtItems = dt && dt.items ? Array.prototype.slice.call(dt.items) : [];
      for (const it of dtItems) {
        if (!it || it.kind !== "file") continue;
        const entry = typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null;
        if (entry) queue.push({ entry: entry, rel: "" });
      }
      if (!queue.length) {
        const files = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
        for (const f of files) {
          const src = api.fsPathForFile ? api.fsPathForFile(f) : (f.path || "");
          if (src && f.name) out.push({ src: src, rel: f.name });
        }
        return resolve(out);
      }
      const process = () => {
        const job = queue.shift();
        if (!job) return resolve(out);
        const entry = job.entry;
        if (!entry) return process();
        if (entry.isFile) {
          entry.file(
            (file) => {
              const src = api.fsPathForFile ? api.fsPathForFile(file) : (file.path || "");
              if (src && file.name) out.push({ src: src, rel: (job.rel ? job.rel + "/" : "") + file.name });
              process();
            },
            () => process()
          );
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const nextBatch = () => {
            reader.readEntries(
              (list) => {
                const arr = list || [];
                if (!arr.length) return process();
                for (const en of arr) queue.push({ entry: en, rel: job.rel + entry.name + "/" });
                nextBatch();
              },
              () => process()
            );
          };
          nextBatch();
        } else process();
      };
      process();
    });
  }

  function initProjectDnD() {
    if (!isElectron) return;
    const panel = $("project-panel");
    const tree = $("tree");
    const hint = $("drop-hint");
    let dropDir = projectDir();
    let dragDepth = 0;

    const clearRowHighlight = () => {
      tree.querySelectorAll(".tree-row.drop-target").forEach((r) => r.classList.remove("drop-target"));
    };
    const showHint = (dir) => {
      if (!dir) return;
      dropDir = dir;
      hint.innerHTML = dir === projectDir()
        ? "📥 Отпустите — скопирую файлы в корень проекта"
        : "📥 Отпустите — скопирую файлы в «" + esc(dir) + "»";
      hint.classList.remove("hidden");
    };

    window.addEventListener("dragenter", (e) => {
      if (!isElectron || panel.classList.contains("hidden")) return;
      e.preventDefault();
      dragDepth++;
    });
    window.addEventListener("dragover", (e) => {
      if (!isElectron || panel.classList.contains("hidden")) return;
      const hasFiles = e.dataTransfer && Array.prototype.slice.call(e.dataTransfer.items || []).some((i) => i.kind === "file");
      if (!hasFiles) return;
      e.preventDefault();
      const row = e.target && e.target.closest ? e.target.closest(".tree-row.dir") : null;
      clearRowHighlight();
      if (row && row.dataset && row.dataset.dir) {
        row.classList.add("drop-target");
        showHint(row.dataset.dir);
      } else {
        showHint(projectDir());
      }
    });
    window.addEventListener("dragleave", (e) => {
      if (!isElectron) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        hint.classList.add("hidden");
        clearRowHighlight();
      }
    });
    window.addEventListener("drop", async (e) => {
      if (!isElectron) return;
      const target = e.target;
      const insidePanel = target && target.closest && target.closest("#project-panel");
      if (panel.classList.contains("hidden") || (!insidePanel && hint.classList.contains("hidden"))) return;
      e.preventDefault();
      dragDepth = 0;
      hint.classList.add("hidden");
      clearRowHighlight();
      const dir = dropDir || projectDir();
      if (!dir) {
        toast("Сначала выбери рабочую директорию");
        return;
      }
      const items = await collectDrop(e.dataTransfer);
      if (!items.length) {
        toast("Не удалось получить файлы из перетаскивания");
        return;
      }
      const r = await api.fsImportDropped(dir, items);
      if (!r) {
        toast("Ошибка импорта файлов");
        return;
      }
      const added = (r.created || []).length;
      const failed = (r.errors || []).length;
      if (added && failed) toastShort("✅ Скопировано: " + added + ", ошибок: " + failed);
      else if (added) toastShort("✅ Скопировано файлов: " + added + " → " + dir);
      else toastShort("❌ " + ((r.errors || []).join("; ") || "Ничего не скопировано"));
      refreshTree();
    });
  }

  // ═══ Статус-бар (полоса внизу окна) ═══
  let sbChanges = 0; // изменённых файлов (последний git status)
  let sbVersion = ""; // версия кода из OTA-статуса

  function switchPanelTab(name) {
    const b = document.querySelector('.panel-tab[data-tab="' + name + '"]');
    if (b) b.click();
  }

  function showPanelTab(name) {
    const panel = $("project-panel");
    if (panel && panel.classList.contains("hidden")) togglePanel();
    switchPanelTab(name);
  }

  function sbProjectLabel() {
    const sel = $("project-select");
    if (sel && sel.selectedIndex >= 0) {
      const opt = sel.options[sel.selectedIndex];
      if (opt && opt.value) return String(opt.textContent || "").replace(/\s*⚠$/, "");
    }
    const dir = projectDir();
    return dir ? pathBase(dir) : "";
  }

  function updateStatusBar() {
    const repoEl = $("panel-repo");
    const hasRepo = !!repoRoot && !!repoEl && !repoEl.classList.contains("hidden");
    const proj = $("sb-project-name");
    if (proj) {
      proj.textContent = sbProjectLabel() || "проект не выбран";
      const btn = $("sb-project");
      if (btn) btn.title = (projectDir() || "Проект не выбран") + " — открыть файлы проекта";
    }
    const branchEl = $("sb-branch-name");
    const branchBtn = $("sb-branch");
    if (branchEl && branchBtn) {
      if (hasRepo) {
        branchEl.textContent = ($("panel-branch") && $("panel-branch").textContent) || "HEAD";
        branchBtn.classList.remove("hidden");
      } else {
        branchBtn.classList.add("hidden");
      }
    }
    const chBtn = $("sb-changes");
    const chNum = $("sb-changes-num");
    if (chBtn && chNum) {
      if (hasRepo) {
        chBtn.classList.remove("hidden");
        chNum.textContent = String(sbChanges);
        chBtn.classList.toggle("has-changes", sbChanges > 0);
        chBtn.classList.toggle("clean", sbChanges === 0);
        chBtn.title = sbChanges ? sbChanges + " изменённых файлов — открыть «Изменения»" : "Изменений нет — всё закоммичено";
      } else {
        chBtn.classList.add("hidden");
      }
    }
    const dot = $("sb-run-dot");
    const rtxt = $("sb-run-text");
    const runBtn = $("sb-run");
    if (dot && rtxt) {
      dot.className = "sb-dot" + (previewRunning ? " on" : "");
      let port = "";
      try {
        const u = new URL(settings.previewUrl || "http://localhost:5000");
        port = u.port || (u.protocol === "https:" ? "443" : "80");
      } catch {
        port = "";
      }
      rtxt.textContent = previewRunning ? "dev-сервер" + (port ? " :" + port : "") : "не запущен";
      if (runBtn) runBtn.title = previewRunning ? "Dev-сервер запущен — открыть превью" : "Dev-сервер остановлен — открыть превью";
    }
    const mtxt = $("sb-model-text");
    if (mtxt) mtxt.textContent = settings.model ? providerLabel() + " · " + settings.model : "Модель не выбрана";
    const vtxt = $("sb-version-text");
    if (vtxt) vtxt.textContent = sbVersion || "—";
  }

  // Клики по статус-бару
  if ($("sb-project")) $("sb-project").onclick = () => showPanelTab("files");
  if ($("sb-branch")) $("sb-branch").onclick = () => showPanelTab("changes");
  if ($("sb-changes")) $("sb-changes").onclick = () => showPanelTab("changes");
  if ($("sb-run")) $("sb-run").onclick = () => openSidePanel("preview");
  if ($("sb-model")) $("sb-model").onclick = () => toggleModelPopup();
  if ($("sb-version"))
    $("sb-version").onclick = () => {
      openSettings();
      showSettingsTab("ota");
    };

  // ── Коммиты ──
  async function refreshRepo() {
    const el = $("panel-repo");
    const listEl = $("commit-list");
    $("commit-summary").textContent = "";
    $("commit-actions").innerHTML = "";
    const dir = projectDir();
    if (!isElectron || !dir) {
      el.classList.add("hidden");
      repoRoot = null;
      listEl.innerHTML = '<div class="tree-empty">Выбери рабочую директорию — здесь появятся файлы и коммиты.</div>';
      return;
    }
    const info = await api.gitRepoInfo(dir);
    if (!info || !info.ok) {
      el.classList.add("hidden");
      repoRoot = null;
      listEl.innerHTML = '<div class="tree-empty">' + esc(info && info.error) + "</div>";
      return;
    }
    if (!info.isRepo) {
      el.classList.add("hidden");
      repoRoot = null;
      listEl.innerHTML =
        '<div class="tree-empty">Эта папка — не git-репозиторий. Клонируй репозиторий полем выше или выбери другую рабочую папку.</div>';
      return;
    }
    repoRoot = info.root;
    el.classList.remove("hidden");
    $("panel-branch").textContent = info.branch || "HEAD";
    $("panel-branch").title = "Ветка";
    $("panel-remote").textContent = info.remote || "";
    $("panel-remote").title = info.remote || "";
    await refreshCommits();
    if (panelTab === "changes") await refreshChanges();
  }

  async function refreshCommits() {
    const summaryEl = $("commit-summary");
    const actionsEl = $("commit-actions");
    const listEl = $("commit-list");
    summaryEl.textContent = "";
    actionsEl.innerHTML = "";
    listEl.innerHTML = "";
    if (!repoRoot) return;
    const [st, log] = await Promise.all([api.gitStatus(repoRoot), api.gitLog(repoRoot, 60)]);
    if (!st || !st.ok) {
      listEl.innerHTML = '<div class="tree-empty">' + esc(st && st.error) + "</div>";
      return;
    }
    const parts = [];
    parts.push("🌿 " + (st.detached ? "HEAD (detached)" : st.branch || "—"));
    if (st.ahead) parts.push("↑" + st.ahead);
    if (st.behind) parts.push("↓" + st.behind);
    if (st.staged.length) parts.push("📌 staged: " + st.staged.length);
    if (st.unstaged.length) parts.push("✏️ изменено: " + st.unstaged.length);
    if (st.untracked.length) parts.push("🆕 новых: " + st.untracked.length);
    summaryEl.textContent = parts.join(" · ");
    summaryEl.title = "git status";
    // Счётчик изменений в статус-баре обновляем сразу при загрузке репозитория
    sbChanges = st.staged.length + st.unstaged.length + st.untracked.length;
    updateStatusBar();

    if (log && log.ok && log.commits.length) {
      const bUndo = document.createElement("button");
      bUndo.className = "btn btn-small";
      bUndo.textContent = "↩ Отменить последний коммит";
      bUndo.title = "Безопасно (git reset --soft HEAD~1): последний коммит убирается, а его изменения возвращаются как незакоммиченные — ничего не теряется.";
      bUndo.onclick = () =>
        confirmModal(
          "Отменить последний коммит?",
          "Коммит «" + log.commits[0].message.slice(0, 80) + "» будет убран из истории, а его изменения вернутся в рабочую папку как незакоммиченные.\nНичего не удаляется — можно закоммитить заново.",
          doUndoLastCommit
        );
      actionsEl.appendChild(bUndo);
    }

    if (st.staged.length || st.unstaged.length) {
      const b = document.createElement("button");
      b.className = "btn btn-danger btn-small";
      b.textContent = "↩ Отменить все изменения";
      b.title = "Вернуть изменённые файлы к состоянию последнего коммита (git restore .). Новые неотслеживаемые файлы не удаляются.";
      b.onclick = () =>
        confirmModal(
          "Отменить незакоммиченные изменения?",
          "Все правки в рабочей папке «" + repoRoot + "» будут отменены.\nНовые файлы, которые ещё не в git, останутся на месте.",
          doRestore,
          true
        );
      actionsEl.appendChild(b);
    }

    if (!log || !log.ok) {
      listEl.innerHTML = '<div class="tree-empty">' + esc(log && log.error) + "</div>";
      return;
    }
    if (!log.commits.length) {
      listEl.innerHTML = '<div class="tree-empty">Коммитов пока нет</div>';
      return;
    }
    for (const c of log.commits) listEl.appendChild(buildCommitRow(c));
  }

  // ── Вкладка «Изменения»: что изменилось, дифф, коммит и push ──
  async function refreshChanges() {
    const summaryEl = $("changes-summary");
    const listEl = $("change-list");
    summaryEl.textContent = "";
    listEl.innerHTML = "";
    if (!repoRoot) {
      summaryEl.textContent = "Открой git-репозиторий — здесь появятся изменения, которые можно закоммитить и запушить.";
      sbChanges = 0;
      updateStatusBar();
      return;
    }
    const st = await api.gitStatus(repoRoot);
    if (!st || !st.ok) {
      summaryEl.textContent = (st && st.error) || "Ошибка git status";
      return;
    }
    const total = st.staged.length + st.unstaged.length + st.untracked.length;
    sbChanges = total;
    updateStatusBar();
    if (!total) {
      summaryEl.textContent = "✨ Изменений нет — всё закоммичено. Чтобы запушить на GitHub, жми «Push».";
      return;
    }
    summaryEl.textContent = total + " изменённых файлов · ветка " + (st.branch || "HEAD");
    const groups = [
      { title: "📌 В индексе (staged)", cls: "staged", items: st.staged },
      { title: "✏️ Изменено", cls: "modified", items: st.unstaged },
      { title: "🆕 Новые", cls: "untracked", items: st.untracked },
    ];
    for (const g of groups) {
      if (!g.items.length) continue;
      const gTitle = document.createElement("div");
      gTitle.className = "change-group";
      gTitle.textContent = g.title;
      listEl.appendChild(gTitle);
      for (const f of g.items) {
        const row = document.createElement("div");
        row.className = "change-item" + (g.cls === "untracked" ? " untracked-row" : "");
        const badge = document.createElement("span");
        badge.className = "change-status " + g.cls;
        badge.textContent = g.cls === "staged" ? "staged" : g.cls === "untracked" ? "+ новый" : "изменён";
        const nm = document.createElement("span");
        nm.className = "change-name";
        nm.textContent = f;
        nm.title = f;
        row.appendChild(badge);
        row.appendChild(nm);
        row.title = "Клик — показать дифф";
        // Чекбокс для выбора файла
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "change-cb";
        cb.dataset.file = f;
        cb.dataset.group = g.cls;
        cb.checked = selectedChanges.has(f);
        cb.onclick = (ev) => { ev.stopPropagation(); toggleChangeSelect(f, cb.checked); };
        row.onclick = () => showDiff(repoRoot, f);
        row.insertBefore(cb, row.firstChild);
        listEl.appendChild(row);
      }
    }
    updateChangeActions();
  };

  // ── Чекбоксы: выбор / снятие ──
  function toggleChangeSelect(file, checked) {
    if (checked) selectedChanges.add(file); else selectedChanges.delete(file);
    updateChangeActions();
  }
  function updateChangeActions() {
    const bar = $("change-actions-bar");
    bar.classList.toggle("visible", selectedChanges.size > 0);
    // Обновить счётчик в кнопках
    const n = selectedChanges.size;
    const btnUnstage = $("btn-unstage-selected");
    const btnDel = $("btn-untrack-selected");
    btnUnstage.textContent = "↩ Убрать из staged" + (n ? " (" + n + ")" : "");
    btnDel.textContent = "🗑 Удалить выбранные" + (n ? " (" + n + ")" : "");
    // Select all checkbox
    const all = document.querySelectorAll(".change-cb");
    const selAll = $("change-select-all");
    if (all.length) selAll.checked = Array.from(all).every((cb) => cb.checked);
  }

  // ── Выбрать все / снять все ──
  $("change-select-all").onclick = () => {
    const checked = $("change-select-all").checked;
    document.querySelectorAll(".change-cb").forEach((cb) => {
      cb.checked = checked;
      const f = cb.dataset.file;
      if (checked) selectedChanges.add(f); else selectedChanges.delete(f);
    });
    updateChangeActions();
  };

  // ── Убрать из staged ──
  $("btn-unstage-selected").onclick = async () => {
    if (!repoRoot || !selectedChanges.size) return;
    for (const f of selectedChanges) {
      await api.runCommand("git reset HEAD -- " + JSON.stringify(f), repoRoot);
    }
    selectedChanges.clear();
    refreshChanges();
  };

  // ── Удалить выбранные ──
  $("btn-untrack-selected").onclick = async () => {
    if (!repoRoot || !selectedChanges.size) return;
    const files = [...selectedChanges];
    confirmModal(
      "Удалить " + files.length + " файл(ов)?",
      "Файлы будут удалены с диска и из git. Это необратимо.",
      async () => {
        for (const f of files) {
          await api.runCommand("git rm -f " + JSON.stringify(f), repoRoot);
        }
        selectedChanges.clear();
        refreshChanges();
      }
    );
  };

  // Показ диффа/содержимого файла в оверлее
  async function showDiff(root, rel) {
    if (!isElectron) return;
    const res = await api.gitDiff(root, rel);
    const overlay = $("file-overlay");
    const pathEl = $("file-path");
    const content = $("file-content");
    content.innerHTML = '<div class="file-error">Загружаю...</div>';
    pathEl.textContent = rel;
    overlay.classList.remove("hidden");
    if (!res || !res.ok) {
      content.innerHTML = "";
      const d = document.createElement("div");
      d.className = "file-error";
      d.textContent = (res && res.error) || "Нет изменений";
      content.appendChild(d);
      return;
    }
    const pre = document.createElement("pre");
    pre.className = "code-view";
    if (res.untracked) {
      const note = document.createElement("div");
      note.className = "diff-file-head";
      note.textContent = "🆕 Новый файл (ещё не в git)";
      pre.appendChild(note);
      const f = await api.fsReadFile(res.path || rel);
      if (f && f.ok) {
        for (const ln of f.content.split("\n").slice(0, 800)) {
          const line = document.createElement("div");
          line.className = "diff-line add";
          line.textContent = "+ " + ln;
          pre.appendChild(line);
        }
      } else {
        const d = document.createElement("div");
        d.className = "file-error";
        d.textContent = (f && f.error) || "Не удалось прочитать файл";
        pre.appendChild(d);
      }
    } else {
      for (const ln of String(res.diff || "").split("\n")) {
        const line = document.createElement("div");
        let cls = "";
        if (/^(@@|diff --git|index |--- |\+\+\+ )/.test(ln)) cls = "meta";
        else if (/^\+/.test(ln)) cls = "add";
        else if (/^-/.test(ln)) cls = "del";
        line.className = "diff-line" + (cls ? " " + cls : "");
        line.textContent = ln || " ";
        pre.appendChild(line);
      }
    }
    content.innerHTML = "";
    content.appendChild(pre);
  }

  async function doCommit() {
    if (!repoRoot) return;
    const msg = $("commit-msg").value.trim();
    if (!msg) {
      toast("Напиши сообщение коммита");
      return;
    }
    const btn = $("btn-commit");
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const r = await api.gitCommit(repoRoot, msg);
      toastShort(r && r.ok ? "✅ Коммит создан" : "❌ " + ((r && r.error) || "Ошибка"));
      if (r && r.ok) $("commit-msg").value = "";
    } finally {
      btn.disabled = false;
      btn.textContent = "Коммит";
    }
    refreshRepo();
  }

  async function doPush() {
    if (!repoRoot) return;
    const btn = $("btn-push");
    btn.disabled = true;
    btn.textContent = "📤 …";
    try {
      const r = await api.gitPush(repoRoot);
      toastShort(r && r.ok ? "✅ Изменения отправлены на GitHub" : "❌ " + ((r && r.error) || "Ошибка"));
    } finally {
      btn.disabled = false;
      btn.textContent = "📤 Push";
    }
    refreshRepo();
  }

  async function doPull() {
    if (!repoRoot) return;
    const btn = $("btn-pull");
    btn.disabled = true;
    btn.textContent = "📥 …";
    try {
      const r = await api.gitPull(repoRoot);
      toastShort(r && r.ok ? "✅ Изменения получены с GitHub" : "❌ " + ((r && r.error) || "Ошибка"));
    } finally {
      btn.disabled = false;
      btn.textContent = "📥 Pull";
    }
    refreshRepo();
  }

  function buildCommitRow(c) {
    const row = document.createElement("div");
    row.className = "commit-row";
    const head = document.createElement("div");
    head.className = "commit-head";
    const hash = document.createElement("span");
    hash.className = "commit-hash";
    hash.textContent = c.short;
    hash.title = c.hash;
    const msg = document.createElement("span");
    msg.className = "commit-msg";
    msg.textContent = c.message;
    msg.title = c.message;
    const meta = document.createElement("span");
    meta.className = "commit-meta";
    meta.textContent = (c.author || "—") + (c.date ? " · " + fmtDate(c.date) : "");
    meta.title = c.email || "";
    head.appendChild(hash);
    head.appendChild(msg);
    head.appendChild(meta);
    const detail = document.createElement("div");
    detail.className = "commit-detail hidden";
    let detailLoaded = false;
    head.onclick = async () => {
      if (!detail.classList.contains("hidden")) {
        detail.classList.add("hidden");
        return;
      }
      detail.classList.remove("hidden");
      if (detailLoaded) return;
      detail.innerHTML = '<div class="commit-loading">Загружаю...</div>';
      const d = await api.gitCommitDetail(repoRoot, c.hash);
      detailLoaded = true;
      detail.innerHTML = "";
      if (!d || !d.ok) {
        detail.innerHTML = '<div class="tree-empty">' + esc(d && d.error) + "</div>";
        return;
      }
      if (d.files && d.files.length) {
        const files = document.createElement("div");
        files.className = "commit-files";
        for (const f of d.files) {
          const fl = document.createElement("div");
          fl.className = "commit-file";
          const st = document.createElement("span");
          st.className = "commit-file-status " + f.status;
          st.textContent = f.status === "added" ? "+" : f.status === "deleted" ? "−" : "±";
          const nm = document.createElement("span");
          nm.className = "commit-file-name";
          nm.textContent = f.path;
          nm.title = f.path;
          const ns = document.createElement("span");
          ns.className = "commit-file-nums";
          ns.textContent = (f.additions ? "+" + f.additions : "") + (f.deletions ? " −" + f.deletions : "");
          fl.appendChild(st);
          fl.appendChild(nm);
          fl.appendChild(ns);
          files.appendChild(fl);
        }
        detail.appendChild(files);
      }
      const btns = document.createElement("div");
      btns.className = "commit-btns";
      const bRevert = document.createElement("button");
      bRevert.className = "btn btn-small";
      bRevert.textContent = "↩ Откатить (revert)";
      bRevert.title = "Создаёт новый коммит с обратными изменениями. История сохраняется.";
      bRevert.onclick = (e) => {
        e.stopPropagation();
        confirmModal(
          "Откатить коммит?",
          "Будет создан новый коммит, отменяющий «" + c.message.slice(0, 80) + "».\nИстория останется нетронутой.",
          () => doRevert(c.hash)
        );
      };
      const bReset = document.createElement("button");
      bReset.className = "btn btn-danger btn-small";
      bReset.textContent = "⛔ Сбросить сюда";
      bReset.title = "Жёсткий откат (git reset --hard): все изменения после этого коммита будут удалены безвозвратно";
      bReset.onclick = (e) => {
        e.stopPropagation();
        confirmModal(
          "Жёсткий сброс к " + c.short + "?",
          "Все коммиты и правки после " + c.short + " («" + c.message.slice(0, 80) + "» и более новые) будут УДАЛЕНЫ безвозвратно.\nОткат невозможен!",
          () => doReset(c.hash),
          true
        );
      };
      btns.appendChild(bRevert);
      btns.appendChild(bReset);
      detail.appendChild(btns);
    };
    row.appendChild(head);
    row.appendChild(detail);
    return row;
  }

  async function doRevert(hash) {
    const r = await api.gitRevert(repoRoot, hash);
    toastShort(r && r.ok ? "✅ " + (r.out || "Коммит отменён") : "❌ " + ((r && r.error) || "Ошибка"));
    refreshRepo();
  }

  async function doReset(hash) {
    const r = await api.gitResetHard(repoRoot, hash);
    toastShort(r && r.ok ? "✅ " + (r.out || "Сброшено") : "❌ " + ((r && r.error) || "Ошибка"));
    refreshRepo();
  }

  async function doRestore() {
    const r = await api.gitRestore(repoRoot);
    toastShort(r && r.ok ? "✅ " + (r.out || "Изменения отменены") : "❌ " + ((r && r.error) || "Ошибка"));
    refreshRepo();
  }

  async function doUndoLastCommit() {
    const r = await api.gitUndoLastCommit(repoRoot);
    toastShort(r && r.ok ? "✅ " + (r.out || "Коммит отменён") : "❌ " + ((r && r.error) || "Ошибка"));
    refreshRepo();
  }

  // ── Публикация папки проекта как НОВОГО репозитория GitHub ──
  function openPublishDialog() {
    if (!isElectron) {
      toast("Публикация на GitHub доступна только в приложении на ПК");
      return;
    }
    if (!settings.githubToken) {
      toast("Сначала подключи GitHub: Настройки → GitHub");
      return;
    }
    const dir = projectDir();
    if (!dir) {
      toast("Сначала выбери папку проекта (📁 в панели проекта или Настройки)");
      return;
    }
    const base = String(dir.split(/[\\/]/).pop() || "")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "my-project";
    $("publish-dir").textContent = "Папка: " + dir;
    $("publish-dir").title = dir;
    $("publish-name").value = base;
    $("publish-desc").value = "";
    $("publish-private").checked = true;
    $("publish-hint").textContent = "";
    const ok = $("btn-publish-ok");
    ok.disabled = false;
    ok.textContent = "Создать и выгрузить";
    $("publish-overlay").classList.remove("hidden");
    setTimeout(() => $("publish-name").focus(), 60);
  }

  function closePublishDialog() {
    $("publish-overlay").classList.add("hidden");
  }

  async function doPublish() {
    const name = $("publish-name").value.trim();
    const desc = $("publish-desc").value.trim();
    const dir = projectDir();
    if (!name) {
      $("publish-hint").textContent = "Введи имя репозитория.";
      return;
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.length > 100) {
      $("publish-hint").textContent = "Имя: только буквы, цифры, точка, дефис, подчёркивание (без пробелов, не с точки).";
      return;
    }
    const btn = $("btn-publish-ok");
    btn.disabled = true;
    btn.textContent = "⏳ Создаём и выгружаем…";
    $("publish-hint").textContent = "";
    try {
      const r = await api.githubPublish({ dir, name, description: desc, private: $("publish-private").checked });
      if (r && r.ok) {
        closePublishDialog();
        // main сохранил githubRepoSlug/Dir — обновляем локальное состояние и панели
        const fresh = await api.getSettings();
        settings = normalize(fresh);
        renderGithubSection();
        if (typeof renderRepoSelector === "function") renderRepoSelector();
        refreshProject();
        refreshProjects();
        toastShort("✅ " + (r.message || "Опубликовано на GitHub"));
      } else {
        $("publish-hint").textContent = "❌ " + ((r && r.error) || "Ошибка публикации");
      }
    } catch (e) {
      $("publish-hint").textContent = "❌ " + (e && e.message ? e.message : String(e));
    } finally {
      btn.disabled = false;
      btn.textContent = "Создать и выгрузить";
    }
  }

  async function cloneRepo() {
    const url = $("clone-url").value.trim();
    if (!url) {
      toast("Вставь URL репозитория");
      return;
    }
    if (!/^(https?:\/\/|git@)/i.test(url)) {
      toast("URL должен начинаться с https:// или git@");
      return;
    }
    // Рабочую директорию на этом шаге не требуем: если она пустая или защищена от записи,
    // бэкенд сам подберёт записываемую папку (pickCloneBase) и сообщит, куда склонировал.
    $("btn-clone").disabled = true;
    let ok = false;
    let msg = "Ошибка";
    try {
      const r = await api.gitClone(settings.workingDir, url);
      ok = r && r.ok;
      msg = ok ? "Клонировано: " + r.dir : (r && r.error) || "Ошибка";
      if (ok) {
        $("clone-url").value = "";
        settings.githubRepoDir = r.dir; // панель проекта сразу показывает склонированный репозиторий
        persistSettings();
      }
    } finally {
      $("btn-clone").disabled = false;
    }
    toastShort((ok ? "✅ " : "❌ ") + msg);
    refreshProject();
  }

  // ── Подтверждение ──
  let confirmCb = null;
  function confirmModal(title, text, onOk, danger) {
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = text;
    const okBtn = $("btn-confirm-ok");
    okBtn.className = "btn " + (danger ? "btn-danger" : "btn-primary");
    okBtn.textContent = danger ? "⛔ Да, выполнить" : "Подтвердить";
    confirmCb = onOk;
    $("confirm-overlay").classList.remove("hidden");
  }

  // ── GitHub ──
  async function renderGithubSection() {
    const connected = !!settings.githubToken;
    $("gh-connected").classList.toggle("hidden", !connected);
    $("gh-disconnected").classList.toggle("hidden", connected);
    if (!connected) {
      $("gh-repos").classList.add("hidden");
      return;
    }
    let login = settings.githubLogin || "";
    let avatar = settings.githubAvatarUrl || "";
    if (!login && isElectron) {
      const u = await api.githubUser();
      if (u && u.ok) {
        login = u.login;
        avatar = u.avatar;
        settings.githubLogin = login;
        settings.githubAvatarUrl = avatar;
        persistSettings();
      }
    }
    $("gh-login").textContent = login ? "@" + login : "@github";
    const img = $("gh-avatar");
    if (avatar) {
      img.src = avatar;
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }
    renderRepoSelector();
  }

  function githubConnected() {
    return !!settings.githubToken;
  }

  function escHtml(s) {
    return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function repoItemInner(slug, selected) {
    const r = githubReposList && githubReposList.find((x) => x.slug === slug);
    const [owner, name] = slug.split("/");
    const desc = r && r.description ? r.description : "";
    const lang = r && r.language ? r.language.trim() : "";
    const priv = r && r.isPrivate;
    const updated = r && r.updated ? new Date(r.updated).toLocaleDateString("ru", { day: "numeric", month: "short", year: "numeric" }) : "";
    const meta = [];
    if (priv) meta.push('<span class="dot private" title="Приватный"></span>');
    if (lang) meta.push('<span class="dot language" title="Язык"></span> ' + lang);
    if (updated) meta.push(updated);
    return (
      '<span class="repo-icon">📊</span>' +
      '<span class="repo-info">' +
      '<span class="repo-slug">' + escHtml(owner) + " / " + escHtml(name) + "</span>" +
      (meta.length ? '<span class="repo-meta">' + meta.join(" · ") + "</span>" : "") +
      (desc ? '<span class="repo-desc" style="font-size:11.5px;color:var(--text-faint);">' + escHtml(desc) + "</span>" : "") +
      "</span>" +
      '<button type="button" class="gh-repo-export' + (selected ? " primary" : "") + '" title="Склонировать в рабочую папку">⬇ Выгрузить</button>' +
      (selected ? '<span class="repo-check">✓</span>' : "")
    );
  }

  let reposPage = 1;
  let reposQuery = "";
  let reposMore = false;
  let repoSearchTimer = null;

  async function renderRepoSelector() {
    const box = $("gh-repos");
    const body = $("gh-repos-body");
    const list = $("gh-repo-list");
    const status = $("gh-repos-status");
    const chev = $("repo-chev");
    list.innerHTML = "";
    const selected = (settings.githubRepoSlug || "").trim();
    box.classList.toggle("hidden", !githubConnected());

    if (!githubConnected()) return;

    const hasData = !!githubReposList || !!selected;
    body.classList.toggle("hidden", !hasData);
    if (chev) chev.textContent = hasData ? "▾" : "▸";

    if (!selected && !githubReposList) {
      status.textContent = "Открой аккордеон, чтобы загрузить список репозиториев (или воспользуйся поиском).";
      status.className = "gh-repos-status";
      return;
    }

    if (selected && !githubReposList) {
      // Репозиторий уже выбран (например, после перезапуска приложения) —
      // показываем его без загрузки списка, список можно открыть кликом по заголовку.
      const direct = await api.githubSelectedRepo().catch(() => null);
      if (direct && direct.ok && direct.slug) {
        settings.githubRepoSlug = direct.slug;
        settings.githubRepoDir = direct.dir || "";
        persistSettings();
      }
      status.textContent = "Выбран репозиторий — " + selected +
        (settings.githubRepoDir ? ". Локальная папка: " + settings.githubRepoDir : ". Нажми «⬇ Выгрузить», чтобы склонировать его в рабочую папку.") +
        " Список можно открыть, чтобы переключиться.";
      status.className = "gh-repos-status";
      const item = document.createElement("div");
      item.className = "gh-repo-item selected";
      item.innerHTML = repoItemInner(selected, true);
      const eb = item.querySelector(".gh-repo-export");
      if (eb && !settings.githubRepoDir) {
        eb.onclick = (e) => {
          e.stopPropagation();
          exportRepoItem(selected, eb);
        };
      }
      list.appendChild(item);
      return;
    }

    renderRepoList();
  }

  function renderRepoList() {
    const list = $("gh-repo-list");
    const more = $("gh-repo-more");
    const status = $("gh-repos-status");
    const selected = (settings.githubRepoSlug || "").trim();
    list.innerHTML = "";
    if (!githubReposList || !githubReposList.length) {
      if (more) more.classList.add("hidden");
      status.textContent = reposQuery
        ? "Поиск «" + reposQuery + "»: ничего не найдено. Проверь имя или введи точный owner/repo (например: facebook/react)."
        : "Репозиториев не найдено.";
      status.className = "gh-repos-status";
      return;
    }
    status.textContent = reposQuery
      ? "Поиск «" + reposQuery + "»: найдено " + githubReposList.length + " — нажми на репозиторий, затем «⬇ Выгрузить» склонирует его в рабочую папку."
      : "Найдено репозиториев: " + githubReposList.length + (reposMore ? " (первые 100, есть ещё)" : "") +
        ". Нажми на репозиторий — появится «⬇ Выгрузить», который склонирует его в рабочую папку.";
    status.className = "gh-repos-status";
    for (const r of githubReposList) {
      const isSelected = r.slug === selected;
      const item = document.createElement("div");
      item.className = "gh-repo-item" + (isSelected ? " selected" : "");
      item.innerHTML = repoItemInner(r.slug, isSelected);
      item.onclick = () => selectRepoItem(r.slug);
      const exportBtn = item.querySelector(".gh-repo-export");
      if (exportBtn) {
        exportBtn.onclick = (e) => {
          e.stopPropagation();
          exportRepoItem(r.slug, exportBtn);
        };
      }
      list.appendChild(item);
    }
    if (more) more.classList.toggle("hidden", !reposMore);
  }

  async function fetchRepos(opts) {
    opts = opts || {};
    const q = typeof opts.query === "string" ? opts.query.trim() : reposQuery;
    const page = opts.page || 1;
    const append = !!opts.append;
    const status = $("gh-repos-status");
    const list = $("gh-repo-list");
    if (append && githubReposList && githubReposList.length) {
      status.textContent = "Загружаю ещё…";
    } else {
      reposQuery = q;
      status.textContent = q ? "Поиск «" + q + "»…" : "Загрузка списка репозиториев…";
      list.innerHTML = "";
    }
    status.className = "gh-repos-status";
    try {
      const res = await api.githubRepos({ query: q, page: page });
      if (!res || !res.ok) throw new Error((res && res.error) || "Не удалось загрузить список");
      const items = res.repos || [];
      githubReposList = append ? (githubReposList || []).concat(items) : items;
      reposQuery = q;
      reposPage = page;
      reposMore = !!res.hasMore;
      renderRepoList();
    } catch (e) {
      status.textContent = "Ошибка: " + (e.message || String(e));
      status.className = "gh-repos-status err";
      if (!append) githubReposList = null;
    }
  }

  // Клик по строке репозитория = выбор (без клонирования). Клонирует явная кнопка «⬇ Выгрузить».
  async function selectRepoItem(slug) {
    const status = $("gh-repos-status");
    const selected = (settings.githubRepoSlug || "").trim();
    if (selected === slug) {
      status.textContent = "Репозиторий уже выбран: " + slug + ". Нажми «⬇ Выгрузить», чтобы склонировать его в рабочую папку.";
      status.className = "gh-repos-status";
      return;
    }
    if (!isElectron) {
      status.textContent = "Клонирование GitHub-репозиториев доступно в приложении на ПК.";
      status.className = "gh-repos-status err";
      return;
    }
    status.textContent = "Выбираю репозиторий «" + slug + "»...";
    status.className = "gh-repos-status";
    const res = await api.githubPickRepo(slug);
    if (!res || !res.ok) {
      status.textContent = "Ошибка: " + ((res && res.error) || "Не удалось выбрать репозиторий");
      status.className = "gh-repos-status err";
      return;
    }
    settings.githubRepoSlug = slug;
    settings.githubRepoDir = "";
    persistSettings();
    renderRepoList();
    status.textContent = "Выбран «" + slug + "». Нажми «⬇ Выгрузить» — склонируется в рабочую папку" +
      (settings.workingDir ? " (" + settings.workingDir + ")" : " (домашнюю папку)") + ".";
    status.className = "gh-repos-status";
  }

  // «⬇ Выгрузить»: явное клонирование выбранного репозитория в рабочую директорию.
  async function exportRepoItem(slug, btn) {
    const status = $("gh-repos-status");
    const oldLabel = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = "…"; }
    status.textContent = "Клонирую «" + slug + "» в рабочую папку...";
    status.className = "gh-repos-status";
    const res = await api.githubSelectRepo(slug, settings.workingDir);
    if (btn) { btn.disabled = false; btn.innerHTML = oldLabel; }
    if (!res || !res.ok) {
      status.textContent = "Ошибка: " + ((res && res.error) || "Не удалось склонировать");
      status.className = "gh-repos-status err";
      return;
    }
    settings.githubRepoSlug = slug;
    settings.githubRepoDir = res.dir || "";
    persistSettings();
    status.textContent = res.message + (res.cloned ? " Теперь можно работать с файлами." : "");
    status.className = "gh-repos-status";
    githubReposList = null;
    reposQuery = "";
    reposMore = false;
    const si = $("gh-repo-search");
    if (si) si.value = "";
    const sc = $("gh-repo-search-clear");
    if (sc) sc.classList.add("hidden");
    renderRepoSelector();
    if (!$("project-panel").classList.contains("hidden")) refreshProject();
  }

  async function unselectRepo() {
    const res = await api.githubUnselectRepo();
    if (res && res.ok) {
      settings.githubRepoSlug = "";
      settings.githubRepoDir = "";
      persistSettings();
      githubReposList = null;
      renderRepoSelector();
      if (!$("project-panel").classList.contains("hidden")) refreshProject();
    }
  }

  function showDeviceModal(code) {
    $("device-code").textContent = code;
    const st = $("device-status");
    st.textContent = "Ожидаем авторизацию...";
    st.className = "device-status";
    $("device-overlay").classList.remove("hidden");
  }

  function closeDeviceModal() {
    $("device-overlay").classList.add("hidden");
  }

  async function connectGithub() {
    if (!isElectron) {
      setSettingsMsg("Авторизация GitHub доступна только в приложении на ПК", true);
      return;
    }
    const clientId = $("s-gh-client-id").value.trim();
    if (!clientId) {
      setSettingsMsg("Вставь Client ID OAuth-приложения GitHub (или создай его по ссылке ниже).", true);
      return;
    }
    settings.githubClientId = clientId;
    persistSettings();
    const res = await api.githubDeviceStart();
    if (!res || !res.ok) {
      setSettingsMsg((res && res.error) || "Не удалось начать авторизацию", true);
      return;
    }
    showDeviceModal(res.user_code);
    setSettingsMsg("Код показан. Введи его на github.com/login/device — доступ подключится сам.", false);
  }

  function wireGithubEvents() {
    if (!isElectron) return;
    api.onGithubEvent((ev) => {
      if (ev.type === "done") {
        closeDeviceModal();
        api.getSettings().then((s) => {
          settings = normalize(s);
          fillSettingsUI();
          renderGithubSection();
        });
        setSettingsMsg("GitHub подключён: @" + (ev.login || "github"), false);
        toast("GitHub: @" + (ev.login || ""));
      } else if (ev.type === "error") {
        const st = $("device-status");
        st.textContent = "Ошибка: " + ev.message;
        st.className = "device-status err";
        setSettingsMsg("Ошибка авторизации: " + ev.message, true);
      } else if (ev.type === "expired") {
        const st = $("device-status");
        st.textContent = "Код истёк. Нажми «Отмена» и попробуй снова.";
        st.className = "device-status err";
        setSettingsMsg("Код авторизации истёк. Попробуй ещё раз.", true);
      }
    });
  }

  // ── Ресайзер панели проекта: ширина перетаскиванием ──
  (function initPanelResizer() {
    const panel = $("project-panel");
    const handle = document.createElement("div");
    handle.className = "panel-resize";
    handle.title = "Потяни, чтобы изменить ширину";
    panel.insertBefore(handle, panel.firstChild);
    let dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      document.body.classList.add("resizing-x");
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = $("main").getBoundingClientRect();
      const w = e.clientX - rect.left;
      panel.style.width = Math.min(Math.max(w, 260), window.innerWidth * 0.5) + "px";
      panel.style.minWidth = "0";
    });
    document.addEventListener("mouseup", () => {
      dragging = false;
      document.body.classList.remove("resizing-x");
    });
  })();

  // ── Секреты: переменные окружения ──
  $("btn-env-add").onclick = envAdd;
  $("btn-env-import").onclick = envImportText;
  $("btn-env-file").onclick = () => $("env-file-input").click();
  $("env-file-input").addEventListener("change", (e) => {
    envImportFile(e.target.files && e.target.files[0]);
    e.target.value = "";
  });

  // ── Секреты: пароли сайтов ──
  if ($("btn-vault-add")) $("btn-vault-add").onclick = vaultAdd;
  if ($("btn-vault-clear")) $("btn-vault-clear").onclick = vaultClearForm;
  if ($("btn-vault-eye")) $("btn-vault-eye").onclick = () => toggleKey("s-vault-pass");
  if ($("s-vault-pass")) {
    // Enter в любом поле формы сохраняет запись.
    for (const id of ["s-vault-name", "s-vault-url", "s-vault-login", "s-vault-pass", "s-vault-note"]) {
      const el = $(id);
      if (el) el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          vaultAdd();
        }
      });
    }
  }

  // ── Нижняя панель: терминал + превью ──
  $("btn-toggle-console").onclick = () => {
    if (!isElectron) {
      toast("Консоль доступна в приложении на ПК (Windows/macOS/Linux)");
      return;
    }
    if (sidePanelVisible() && sideTab === "console") closeSidePanel();
    else openSidePanel("console");
  };
  $("btn-toggle-preview").onclick = () => {
    if (sidePanelVisible() && sideTab === "preview") closeSidePanel();
    else openSidePanel("preview");
  };
  $("btn-sp-close").onclick = closeSidePanel;
  document.querySelectorAll(".sp-btn").forEach((b) => {
    b.onclick = () => switchSideTab(b.dataset.sp);
  });
  if (isElectron) api.onTermEvent(onTermEvent);
  $("term-input").addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      termTabComplete();
    } else if (e.key === "Enter") {
      e.preventDefault();
      termSend();
    } else if (e.key === "ArrowUp") {
      if (!termHist.length) return;
      e.preventDefault();
      termHistIdx = termHistIdx < 0 ? termHist.length - 1 : Math.max(0, termHistIdx - 1);
      $("term-input").value = termHist[termHistIdx];
    } else if (e.key === "ArrowDown") {
      if (termHistIdx < 0) return;
      e.preventDefault();
      termHistIdx++;
      $("term-input").value = termHistIdx < termHist.length ? termHist[termHistIdx] : "";
      if (termHistIdx >= termHist.length) termHistIdx = -1;
    }
  });
  $("btn-term-clear").onclick = termReset;
  $("btn-term-stop").onclick = () => {
    if (isElectron) api.termStop();
  };
  $("btn-preview-open").onclick = () => previewOpen($("preview-url").value);
  // Быстрый запуск/остановка проекта в превью
  $("btn-preview-start").onclick = devStartClick;
  $("btn-preview-stop").onclick = devStopClick;
  $("preview-cmd").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      devStartClick();
    }
  });
  if (isElectron && api.onDevEvent) api.onDevEvent(onDevEvent);
  $("preview-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") previewOpen($("preview-url").value);
  });
  $("btn-preview-tab").onclick = previewOpenTab;
  $("btn-preview-reload").onclick = () => {
    if (!previewLoaded) return;
    const f = $("preview-frame");
    f.src = previewLoaded; // перезагрузка сбросом src
  };
  document.querySelectorAll(".dev-btns .dev").forEach((b) => {
    b.onclick = () => previewSetDevice(b.dataset.w);
  });

  // ── Удобство: копирование чата, умная прокрутка, горячие клавиши, ресайзер панели ──
  $("btn-copy-chat").onclick = copyChat;
  $("btn-scroll-bottom").onclick = jumpToBottom;
  $("messages").addEventListener("scroll", updatePinState, { passive: true });

  // Горячие клавиши (дополнение к Ctrl/Cmd+N — новый чат)
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const t = e.target;
    const tag = t && t.tagName ? t.tagName : "";
    const inField = tag === "INPUT" || tag === "TEXTAREA";
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (e.shiftKey) {
        $("chat-search").focus();
        $("chat-search").select();
      } else {
        openPalette("actions");
      }
      return;
    }
    if (mod && e.key.toLowerCase() === "p") {
      e.preventDefault();
      if (e.shiftKey) openPalette("actions");
      else enterFileMode();
      return;
    }
    if (mod && e.key.toLowerCase() === "enter") {
      if (inField && t.id === "input") {
        e.preventDefault();
        sendMessage();
      }
      return;
    }
    if (e.key === "Escape") {
      // В редакторе файла Esc не закрывает панель (им же закрывают подсказки редактора)
      if (t && t.id === "file-editor") return;
      // закрыть любой открытый оверлей
      for (const ov of document.querySelectorAll(".overlay")) {
        if (!ov.classList.contains("hidden")) {
          if (ov.id === "ask-overlay") {
            $("btn-ask-cancel").click(); // отменяем ожидание ответа агента
          } else {
            ov.classList.add("hidden");
          }
          return;
        }
      }
      // затем — правую панель
      if (sidePanelVisible()) closeSidePanel();
      // Esc во время генерации = явная остановка агента. Только реальные нажатия
      // пользователя (e.isTrusted) — синтетические клики агента (appPress Escape) не сработают.
      if (streaming && e.isTrusted) stop();
    }
  });

  // Ресайзер правой панели: тонкая полоска на левом крае (ширина)
  (function initSideResizer() {
    const panel = $("side-panel");
    const handle = document.createElement("div");
    handle.className = "sp-resize";
    handle.title = "Потяни, чтобы изменить ширину";
    panel.insertBefore(handle, panel.firstChild);
    let dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      document.body.classList.add("resizing");
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = $("main").getBoundingClientRect();
      const w = e.clientX - rect.left;
      panel.style.width = Math.min(Math.max(w, 320), window.innerWidth * 0.55) + "px";
    });
    document.addEventListener("mouseup", () => {
      dragging = false;
      document.body.classList.remove("resizing");
    });
  })();

  // ── События панели проекта ──
  $("btn-toggle-panel").onclick = togglePanel;
  $("btn-panel-close").onclick = () => $("project-panel").classList.add("hidden");
  $("btn-panel-refresh").onclick = () => refreshProject();
  $("btn-panel-pick-dir").onclick = async () => {
    if (!isElectron) return;
    const p = await api.pickDirectory();
    if (p) {
      settings.workingDir = p;
      $("s-workdir").value = p;
      persistSettings();
      refreshProject();
    }
  };
  $("btn-clone").onclick = cloneRepo;
  // ── Переключение / создание / удаление проектов ──
  $("project-select").onchange = () => switchProject($("project-select").value);
  $("btn-project-add").onclick = async () => {
    if (!isElectron) {
      toast("Проекты доступны в приложении на ПК");
      return;
    }
    const list = await api.projectsList();
    if (list && list.ok && list.projects.length >= 10) {
      toast("Максимум 10 проектов — убери один из списка (🗑)");
      return;
    }
    openProjectDialog();
  };
  $("btn-project-remove").onclick = () => {
    const id = $("project-select").value;
    if (!id) return;
    confirmModal("Убрать проект из списка?", "Папка на диске НЕ будет удалена.", () => {
      api.projectsRemove(id).then(async (r) => {
        if (!r || !r.ok) {
          toast((r && r.error) || "Не удалось убрать проект");
          return;
        }
        const s = await api.getSettings();
        settings = normalize(s);
        $("s-workdir").value = settings.workingDir || "";
        // Если остался активный проект — переключаемся на его чат.
        if (settings.activeProjectId) {
          const pr = (settings.projects || []).find((p) => p.id === settings.activeProjectId);
          ensureProjectChat(settings.activeProjectId, pr && pr.name);
        }
        toast("Проект убран из списка");
        refreshProject();
        refreshProjects();
      });
    }, false);
  };
  // ── Ручное создание файлов/папок + перетаскивание ──
  $("btn-new-file").onclick = () => {
    if (!isElectron) {
      toast("Создание файлов доступно в приложении на ПК");
      return;
    }
    newProjectFile();
  };
  $("btn-new-folder").onclick = () => {
    if (!isElectron) {
      toast("Создание папок доступно в приложении на ПК");
      return;
    }
    newProjectFolder();
  };
  initProjectDnD();
  // ── Кнопки вкладки «Изменения»: коммит, push, pull ──
  $("btn-commit").onclick = doCommit;
  $("btn-push").onclick = doPush;
  $("btn-pull").onclick = doPull;
  $("commit-msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doCommit();
  });
  $("clone-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") cloneRepo();
  });
  document.querySelectorAll(".panel-tab").forEach((b) => {
    b.onclick = () => {
      panelTab = b.dataset.tab;
      document.querySelectorAll(".panel-tab").forEach((x) => x.classList.toggle("active", x === b));
      $("panel-files").classList.toggle("hidden", panelTab !== "files");
      $("panel-changes").classList.toggle("hidden", panelTab !== "changes");
      $("panel-commits").classList.toggle("hidden", panelTab !== "commits");
      if (panelTab === "commits") refreshRepo();
      else if (panelTab === "changes") refreshChanges();
      else refreshTree();
    };
  });

  // ═══ Палитра команд (Ctrl+K): действия и файлы ═══
  let paletteItems = [];
  let paletteIndex = 0;
  let paletteMode = "actions";
  let paletteFiles = null;

  function paletteActions() {
    const acts = [];
    const A = (icon, title, hint, group, run, when) =>
      acts.push({ icon: icon, title: title, hint: hint || "", group: group, run: run, when: when || null });

    A("💬", "Новый чат", "Ctrl+N", "Чат", () => createChat());
    A("🔄", "Продолжить контекст предыдущего чата", "", "Чат", () => $("btn-continue-chat").click());
    A("🔍", "Поиск по чатам", "Ctrl+Shift+K", "Чат", () => {
      closePalette();
      $("chat-search").focus();
      $("chat-search").select();
    });
    A("📋", "Скопировать чат в буфер", "markdown", "Чат", () => copyChat());
    A("⏹", "Остановить агента", "", "Чат", () => stop(), () => streaming);

    A("📄", "Открыть файл…", "Ctrl+P", "Файлы и проект", () => enterFileMode(), () => isElectron);
    A("📂", "Панель проекта: файлы", "", "Файлы и проект", () => showPanelTab("files"), () => isElectron);
    A("✏️", "Панель проекта: изменения", "", "Файлы и проект", () => showPanelTab("changes"), () => isElectron);
    A("🕘", "Панель проекта: коммиты", "", "Файлы и проект", () => showPanelTab("commits"), () => isElectron);
    A("➕", "Новый файл", "", "Файлы и проект", () => newProjectFile(), () => isElectron);
    A("🗂", "Новая папка", "", "Файлы и проект", () => newProjectFolder(), () => isElectron);
    A("🔎", "Поиск по коду (семантический)", "агент", "Файлы и проект", () => {
      $("input").value = "найди в проекте: ";
      $("input").focus();
    }, () => isElectron);

    A("💾", "Закоммитить изменения", "", "Git и GitHub", () => showPanelTab("changes"), () => isElectron);
    A("📤", "Push на GitHub", "", "Git и GitHub", () => doPush(), () => isElectron);
    A("📥", "Pull из GitHub", "", "Git и GitHub", () => doPull(), () => isElectron);
    A("⬆", "Опубликовать проект на GitHub", "новый репозиторий", "Git и GitHub", () => openPublishDialog(), () => isElectron);

    A("🖥", "Превью и консоль", "", "Запуск и хостинг", () => openSidePanel("preview"), () => isElectron);
    A("⌨️", "Консоль", "логи и команды", "Запуск и хостинг", () => openSidePanel("console"), () => isElectron);
    A("🧹", "Очистить консоль", "", "Запуск и хостинг", () => {
      openSidePanel("console");
      termReset();
    }, () => isElectron);
    A("☁️", "Yandex Cloud — ресурсы", "", "Запуск и хостинг", () => openSidePanel("cloud"), () => isElectron);
    A("🚀", "Задеплоить на Yandex Cloud", "контейнер", "Запуск и хостинг", () => {
      openSidePanel("cloud");
      $("btn-yc-deploy").click();
    }, () => isElectron);

    A("🤖", "Настройки: модель", "", "Настройки", () => openSettings());
    A("🔒", "Настройки: секреты и переменные", "", "Настройки", () => {
      openSettings();
      showSettingsTab("secrets");
    });
    A("🐙", "Настройки: GitHub и проект", "", "Настройки", () => {
      openSettings();
      showSettingsTab("project");
    });
    A("👁", "Настройки: зрение и картинки", "", "Настройки", () => {
      openSettings();
      showSettingsTab("vision");
    });
    A("📱", "Настройки: мобильный доступ", "", "Настройки", () => {
      openSettings();
      showSettingsTab("mobile");
    });
    A("☁️", "Настройки: Yandex Cloud", "", "Настройки", () => {
      openSettings();
      showSettingsTab("yandex");
    });
    A("🔄", "Настройки: self-update (OTA)", "", "Настройки", () => {
      openSettings();
      showSettingsTab("ota");
    });
    A("🛠", "Проверить подключение к модели", "", "Настройки", () => {
      openSettings();
      testConnection();
    });
    return acts;
  }

  function paletteFilter(query) {
    const all = paletteItems.filter((it) => !it.when || it.when());
    const q = String(query || "").trim().toLowerCase();
    if (!q) return all;
    const scored = [];
    for (let i = 0; i < all.length; i++) {
      const it = all[i];
      const title = String(it.title || "").toLowerCase();
      const hay = title + " " + String(it.hint || "").toLowerCase() + " " + String(it.group || "").toLowerCase();
      const pos = hay.indexOf(q);
      if (pos === -1) continue;
      scored.push({ it: it, score: title.indexOf(q) === 0 ? 0 : pos + 1 });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((x) => x.it);
  }

  function paletteRows() {
    return Array.prototype.slice.call($("palette-list").querySelectorAll(".palette-row"));
  }

  function paletteHighlight() {
    const rows = paletteRows();
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle("active", i === paletteIndex);
    const cur = rows[paletteIndex];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }

  function paletteRender() {
    const list = $("palette-list");
    const items = paletteFilter($("palette-input").value);
    if (paletteIndex >= items.length) paletteIndex = Math.max(0, items.length - 1);
    if (paletteIndex < 0) paletteIndex = 0;
    list.innerHTML = "";
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "palette-empty";
      d.textContent = paletteMode === "files" ? "Файлы не найдены (проект не выбран?)" : "Ничего не найдено";
      list.appendChild(d);
      return;
    }
    let lastGroup = "";
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.group && it.group !== lastGroup) {
        lastGroup = it.group;
        const h = document.createElement("div");
        h.className = "palette-sec";
        h.textContent = it.group;
        list.appendChild(h);
      }
      const row = document.createElement("div");
      row.className = "palette-row" + (i === paletteIndex ? " active" : "");
      const ic = document.createElement("span");
      ic.className = "pr-ic";
      ic.textContent = it.icon || "•";
      const t = document.createElement("span");
      t.className = "pr-title";
      t.textContent = it.title;
      row.appendChild(ic);
      row.appendChild(t);
      if (it.hint) {
        const hh = document.createElement("span");
        hh.className = "pr-hint";
        hh.textContent = it.hint;
        row.appendChild(hh);
      }
      row.onclick = () => paletteRun(it);
      row.onmousemove = () => {
        if (paletteIndex !== i) {
          paletteIndex = i;
          paletteHighlight();
        }
      };
      list.appendChild(row);
    }
  }

  function openPalette(mode) {
    paletteMode = mode || "actions";
    paletteItems = paletteMode === "files" ? paletteFiles || [] : paletteActions();
    paletteIndex = 0;
    const ic = $("palette-ic");
    const inp = $("palette-input");
    if (ic) ic.textContent = paletteMode === "files" ? "📄" : "⌘";
    if (inp) {
      inp.placeholder = paletteMode === "files" ? "Имя файла…" : "Действие или файл…";
      inp.value = "";
    }
    $("palette-overlay").classList.remove("hidden");
    paletteRender();
    if (inp) inp.focus();
  }

  function closePalette() {
    $("palette-overlay").classList.add("hidden");
  }

  function paletteRun(item) {
    closePalette();
    try {
      item.run();
    } catch (e) {
      toast("Не удалось выполнить: " + ((e && e.message) || e));
    }
  }

  // Список файлов проекта для быстрого перехода (Ctrl+P)
  async function collectProjectFiles(dir, limit) {
    const out = [];
    const skip = { node_modules: 1, ".git": 1, dist: 1, build: 1, out: 1, ".next": 1, ".nuxt": 1, __pycache__: 1, venv: 1, ".venv": 1, ".idea": 1, ".vscode": 1, coverage: 1 };
    const clean = String(dir || "").replace(/[\\/]+$/, "");
    async function walk(d, prefix) {
      if (out.length >= limit) return;
      const r = await api.fsListTree(d);
      if (!r || !r.ok) return;
      for (let i = 0; i < r.entries.length; i++) {
        if (out.length >= limit) return;
        const e = r.entries[i];
        if (e.isDir) {
          if (skip[e.name]) continue;
          await walk(d + "/" + e.name, prefix + e.name + "/");
        } else {
          const full = d + "/" + e.name;
          out.push({
            icon: fileIcon(e.name),
            title: e.name,
            hint: prefix ? prefix.replace(/\/$/, "") : "корень",
            group: prefix ? "📁 " + prefix.replace(/\/$/, "") : "📄 корень проекта",
            run: () => viewFile(full),
          });
        }
      }
    }
    if (clean) await walk(clean, "");
    return out;
  }

  async function enterFileMode() {
    if (!isElectron) {
      toast("Доступно в приложении на ПК");
      return;
    }
    if (!projectDir()) {
      toast("Сначала выбери рабочую папку проекта");
      return;
    }
    if (!paletteFiles) {
      toast("Собираю список файлов…");
      paletteFiles = await collectProjectFiles(projectDir(), 1200);
    }
    openPalette("files");
  }

  if ($("palette-input")) {
    $("palette-input").addEventListener("input", () => {
      paletteIndex = 0;
      paletteRender();
    });
    $("palette-input").addEventListener("keydown", (e) => {
      const items = paletteFilter($("palette-input").value);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        paletteIndex = Math.min(paletteIndex + 1, items.length - 1);
        paletteHighlight();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        paletteIndex = Math.max(paletteIndex - 1, 0);
        paletteHighlight();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = items[paletteIndex];
        if (it) paletteRun(it);
      } else if (e.key === "Escape" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        closePalette();
      }
    });
  }
  if ($("palette-overlay")) {
    $("palette-overlay").addEventListener("click", (e) => {
      if (e.target === $("palette-overlay")) closePalette();
    });
  }

  // ── События модалок ──
  $("btn-file-close").onclick = () => {
    editMode = false;
    updateFileToolbar();
    $("file-overlay").classList.add("hidden");
  };
  $("file-overlay").addEventListener("click", (e) => {
    if (e.target === $("file-overlay")) $("file-overlay").classList.add("hidden");
  });
  $("btn-file-copy").onclick = () => {
    navigator.clipboard.writeText($("file-path").textContent).then(() => toast("Путь скопирован"));
  };
  $("btn-file-open").onclick = () => {
    if (isElectron) api.fsOpenInExplorer($("file-path").textContent);
  };
  $("btn-file-edit").onclick = () => {
    if (!fileViewPath || !fileCanEdit) return;
    editMode = true;
    renderFileTabs();
    loadActiveFile();
  };
  $("btn-file-save").onclick = saveEditedFile;
  $("btn-file-hl").onclick = () => {
    hlInEditor = !hlInEditor;
    if (editorRepaint) editorRepaint();
    else {
      const wrap = document.querySelector(".code-edit-wrap");
      if (wrap) wrap.classList.toggle("no-hl", !hlInEditor);
    }
    $("btn-file-hl").classList.toggle("active", hlInEditor);
    toast(hlInEditor ? "✨ Подсветка включена" : "Подсветка выключена — обычный текст");
  };
  $("btn-file-delete").onclick = () => {
    if (fileViewPath) deleteFsItem(fileViewPath, false);
  };
  // «⬆ Опубликовать на GitHub» — создать новый репозиторий и выгрузить папку проекта
  $("btn-publish").onclick = openPublishDialog;
  $("btn-publish-cancel").onclick = closePublishDialog;
  $("publish-overlay").addEventListener("click", (e) => {
    if (e.target === $("publish-overlay")) closePublishDialog();
  });
  $("btn-publish-ok").onclick = doPublish;
  $("publish-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doPublish();
    } else if (e.key === "Escape") closePublishDialog();
  });
  // Диалог «Новый проект»
  $("btn-project-cancel").onclick = closeProjectDialog;
  $("project-overlay").addEventListener("click", (e) => {
    if (e.target === $("project-overlay")) closeProjectDialog();
  });
  $("btn-project-pick-dir").onclick = async () => {
    if (!isElectron) return;
    const p = await api.pickDirectory();
    if (p) {
      projectChosenDir = p;
      $("project-dir").value = p;
    }
  };
  $("project-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-project-ok").click();
    else if (e.key === "Escape") closeProjectDialog();
  });
  $("btn-project-ok").onclick = async () => {
    const name = $("project-name").value.trim();
    if (!name) {
      $("project-hint").textContent = "Введи название проекта.";
      return;
    }
    $("btn-project-ok").disabled = true;
    const r = await api.projectsCreate(name, projectChosenDir);
    $("btn-project-ok").disabled = false;
    if (!r || !r.ok) {
      $("project-hint").textContent = (r && r.error) || "Не удалось создать проект";
      return;
    }
    closeProjectDialog();
    const s = await api.getSettings();
    settings = normalize(s);
    $("s-workdir").value = settings.workingDir || "";
    // Новый проект становится активным — сразу переходим в его чат.
    ensureProjectChat(r.project && r.project.id, r.project && r.project.name);
    toast("Проект создан: " + (r.project && r.project.name));
    refreshProject();
    refreshProjects();
  };
  // Диалог ввода имени (новый файл/папка)
  $("btn-input-ok").onclick = () => resolveInput($("input-value").value.trim());
  $("btn-input-cancel").onclick = () => resolveInput(null);
  $("input-overlay").addEventListener("click", (e) => {
    if (e.target === $("input-overlay")) resolveInput(null);
  });
  $("input-value").addEventListener("keydown", (e) => {
    if (e.key === "Enter") resolveInput($("input-value").value.trim());
    else if (e.key === "Escape") resolveInput(null);
  });
  $("input-value").addEventListener("input", () => {
    $("input-hint").textContent = /[\\/:*?"<>|]/.test($("input-value").value)
      ? "Имя не должно содержать символы / \\ : * ? \" < > |"
      : "";
  });
  $("btn-confirm-ok").onclick = () => {
    $("confirm-overlay").classList.add("hidden");
    const cb = confirmCb;
    confirmCb = null;
    if (cb) cb();
  };
  $("btn-confirm-cancel").onclick = () => {
    $("confirm-overlay").classList.add("hidden");
    confirmCb = null;
  };
  $("confirm-overlay").addEventListener("click", (e) => {
    if (e.target === $("confirm-overlay")) {
      $("confirm-overlay").classList.add("hidden");
      confirmCb = null;
    }
  });

  // ── События GitHub ──
  $("btn-gh-connect").onclick = connectGithub;
  $("btn-gh-disconnect").onclick = async () => {
    if (!isElectron) return;
    await api.githubDisconnect();
    settings.githubToken = "";
    settings.githubLogin = "";
    settings.githubAvatarUrl = "";
    persistSettings();
    renderGithubSection();
    setSettingsMsg("GitHub отключён", false);
  };
  $("btn-gh-create-app").onclick = () => {
    if (isElectron) api.openExternal("https://github.com/settings/applications/new");
  };
  $("btn-device-open").onclick = () => {
    if (isElectron) api.openExternal("https://github.com/login/device");
  };

  // ── Мобильный доступ ──
  $("s-mobile-enabled").addEventListener("change", () => {
    $("mobile-fields").classList.toggle("hidden", !$("s-mobile-enabled").checked);
    if ($("s-mobile-enabled").checked) renderMobileStatus();
  });
  $("btn-mobile-pin-regen").onclick = regenerateMobilePin;
  // ── Зрение и генерация изображений (вспомогательная модель) ──
  $("s-vision-enabled").addEventListener("change", () => {
    $("vision-fields").classList.toggle("hidden", !$("s-vision-enabled").checked);
  });
  // ── Локальный self-update (OTA): проверка, откат, открыть папку ──
  $("btn-ota-check").onclick = async () => {
    if (!isElectron) {
      toast("Self-update доступен в приложении на ПК");
      return;
    }
    const r = await api.otaCheck();
    if (r && r.status === "applied") toast("✅ Обновление применено: " + r.version + " — перезапуск…");
    else if (r && r.status === "error") toast("⚠ " + ((r && r.message) || "Ошибка применения обновления"));
    else if (r && r.status === "busy") toast("Агент сейчас работает — обновление применится после");
    else if (r && r.status === "disabled") toast("Self-update выключен в настройках");
    else toast("Обновлений нет — код актуален");
    renderOtaStatus();
  };
  $("btn-ota-rollback").onclick = () => {
    if (!isElectron) return;
    confirmModal("Откатить на предыдущую версию кода?", "Приложение перезапустится с прошлой версией.", () => {
      api.otaRollback();
    });
  };
  $("btn-ota-reset").onclick = () => {
    if (!isElectron) {
      toast("Self-update доступен в приложении на ПК");
      return;
    }
    confirmModal(
      "Полностью сбросить OTA-обновления?",
      "Будет удалён применённый бандл (userData/ota) и папка ota/ рядом с кодом — нерабочее обновление больше не подхватится. Приложение вернётся к установленной версии кода (перезапусти его).",
      () => {
        api.otaReset(true).then((r) => {
          if (r && r.ok) {
            toast("OTA сброшен — код вернётся к установленной версии после перезапуска");
            renderOtaStatus();
          } else {
            toast("Ошибка сброса OTA");
          }
        });
      }
    );
  };
  $("btn-ota-open").onclick = () => {
    if (isElectron) api.otaOpenDir();
  };
  // ── 🧠 Память диалогов: открыть папку и очистить дневник ──
  if ($("btn-memory-open")) $("btn-memory-open").onclick = async () => {
    if (!isElectron || !api.memoryOpenDir) {
      toast("Память диалогов доступна в приложении на ПК");
      return;
    }
    const r = await api.memoryOpenDir();
    if (r && r.ok) toast("Открываю папку памяти диалогов");
    else toast("⚠ Не удалось открыть папку" + (r && r.error ? ": " + r.error : ""));
  };
  if ($("btn-memory-clear")) $("btn-memory-clear").onclick = () => {
    if (!isElectron || !api.memoryClear) return;
    confirmModal(
      "Удалить все сохранённые памятки?",
      "Будут удалены все дни дневника памяти диалогов. Переписка в чатах и заметки проекта не затрагиваются.",
      () => {
        api.memoryClear("").then((r) => {
          toast(r && r.ok ? "🧠 " + r.message : "⚠ Ошибка очистки памяти диалогов");
          renderMemoryStatus();
        });
      }
    );
  };
  if ($("s-context-memory")) $("s-context-memory").addEventListener("change", renderMemoryStatus);
  $("btn-toggle-vision-key").onclick = () => toggleKey("s-vision-key");
  $("btn-toggle-serper-key").onclick = () => toggleKey("s-serper-key");
  if ($("btn-mail-eye")) $("btn-mail-eye").onclick = () => toggleKey("s-mail-pass");
  if ($("btn-mail-detect")) $("btn-mail-detect").onclick = mailFillServers;
  if ($("btn-mail-test")) $("btn-mail-test").onclick = mailDoTest;
  if ($("btn-mail-test-send")) $("btn-mail-test-send").onclick = mailDoTestSend;
  if ($("btn-mail-recent")) $("btn-mail-recent").onclick = mailDoRecent;
  $("btn-refresh-vision-models").onclick = () => loadAuxModels("vision");
  $("btn-refresh-image-models").onclick = () => loadAuxModels("image");
  $("btn-mobile-menu").onclick = () => $("sidebar").classList.toggle("open");
  $("chat-list").addEventListener("click", () => {
    if (window.innerWidth <= 900) $("sidebar").classList.remove("open");
  });  $("btn-device-open").onclick = () => {
    if (isElectron) api.openExternal("https://github.com/login/device");
  };
  $("btn-device-cancel").onclick = () => {
    if (isElectron) api.githubDeviceCancel();
    closeDeviceModal();
  };

  // ── Выбор репозитория GitHub (аккордеон в настройках): поиск + пагинация ──
  const ghSearchInput = $("gh-repo-search");
  const ghSearchClear = $("gh-repo-search-clear");
  ghSearchInput.addEventListener("input", () => {
    const q = ghSearchInput.value;
    ghSearchClear.classList.toggle("hidden", !q.trim());
    clearTimeout(repoSearchTimer);
    repoSearchTimer = setTimeout(() => fetchRepos({ query: q }), q.trim() ? 350 : 0);
  });
  ghSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(repoSearchTimer);
      fetchRepos({ query: ghSearchInput.value });
    } else if (e.key === "Escape") {
      ghSearchInput.value = "";
      ghSearchClear.classList.add("hidden");
      fetchRepos({ query: "" });
    }
  });
  ghSearchClear.onclick = () => {
    ghSearchInput.value = "";
    ghSearchClear.classList.add("hidden");
    clearTimeout(repoSearchTimer);
    fetchRepos({ query: "" });
  };
  $("gh-repo-more").onclick = () => {
    clearTimeout(repoSearchTimer);
    fetchRepos({ query: "", page: (reposPage || 1) + 1, append: true });
  };
  $("gh-repos-head").onclick = async (e) => {
    if (e.target.closest("#btn-gh-unselect-repo")) return;
    const body = $("gh-repos-body");
    const chev = $("repo-chev");
    const opening = body.classList.contains("hidden");
    body.classList.toggle("hidden", !opening);
    if (chev) chev.textContent = opening ? "▾" : "▸";
    if (opening && !githubReposList && !(settings.githubRepoSlug || "").trim()) await fetchRepos();
  };
  $("btn-gh-unselect-repo").onclick = async () => {
    if (!isElectron) {
      toast("Выбор репозитория доступен только в приложении на ПК");
      return;
    }
    await unselectRepo();
  };

  // ─────────────── Старт ───────────────
  loadState().then(() => {
    // Чистим поле поиска: автозаполнение браузера могло подставить URL из настроек
    $("chat-search").value = "";
    if (!chatsData.chats.length) {
      createChat();
    } else {
      renderSidebar();
      renderMessages();
    }
    // Если активен проект — сразу открываем чат, привязанный к нему
    // (агент не должен видеть контекст других проектов).
    if (isElectron && settings.activeProjectId) {
      const pr = (settings.projects || []).find((p) => p.id === settings.activeProjectId);
      ensureProjectChat(settings.activeProjectId, pr && pr.name);
    }
    updateBadge();
    refreshProjects();
    renderOtaStatus(); // версия кода — сразу в статус-бар
    if (isElectron) {
      api.onAiEvent(onAiEvent);
      wireGithubEvents();
    }
  });
})();
