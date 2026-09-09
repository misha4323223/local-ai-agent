"use strict";
const fs = require("fs");
function patch(path, pairs) {
  const src = fs.readFileSync(path, "utf8");
  let out = src;
  for (const [oldS, newS] of pairs) {
    if (!out.includes(oldS)) {
      console.error("НЕ НАЙДЕНО в " + path + ":\n" + oldS.slice(0, 250));
      process.exit(1);
    }
    out = out.split(oldS).join(newS);
  }
  fs.writeFileSync(path, out, "utf8");
  console.log("OK " + path + " (" + pairs.length + " правок)");
}

patch("src/renderer/app.js", [
  // 1. После hideAttachBar добавить хелпер обновления индикатора контекста
  [
    `  function hideAttachBar() {
    pendingImage = null;
    $("attach-bar").classList.add("hidden");
    $("attach-thumb").removeAttribute("src");
  }`,
    `  function hideAttachBar() {
    pendingImage = null;
    $("attach-bar").classList.add("hidden");
    $("attach-thumb").removeAttribute("src");
  }

  // ── Индикатор заполняемости контекста модели ──
  let _lastCtxBudget = 0;
  function updateCtxIndicator() {
    try {
      const chat = getActiveChat();
      if (!chat || !chat.messages.length) { $("ctx-indicator").classList.remove("visible"); return; }
      // Подсчитать токены в истории чата (все сообщения)
      let totalTokens = 0;
      for (const m of chat.messages) totalTokens += AC.estimateMessageTokens(m);
      // Бюджет: используем реальное окно модели, если кэшировано, иначе дефолт
      const s = settings || {};
      const provider = s.provider || "openai";
      const model = s.model || "";
      let budget = _lastCtxBudget || AC.contextBudget(provider, model);
      // Попробовать получить реальное окно из кэша (синхронно, без запроса)
      if (model && provider === "openai" && typeof AC.modelWindow === "function") {
        // modelWindow async, но кэш может быть уже заполнен — берём из estimateTokens эвристики
        // Используем дефолтный budget (обновится при следующем вызове modelWindow)
      }
      const pct = Math.min(100, Math.round((totalTokens / Math.max(budget, 1)) * 100));
      const fill = $("ctx-fill");
      const text = $("ctx-text");
      const ind = $("ctx-indicator");
      ind.classList.add("visible");
      fill.style.width = pct + "%";
      fill.className = "ctx-fill" + (pct >= 90 ? " danger" : pct >= 70 ? " warn" : "");
      text.textContent = pct + "% · " + totalTokens.toLocaleString() + " / " + budget.toLocaleString();
    } catch {}
  }
  // Слушать модель из настроек для бюджета (обновлять при переключении)
  const _origPersist = persistSettings;`,
  ],

  // 2. После btn-attach-remove подключить drag-and-drop и кнопку загрузки файлов
  [
    `  $("btn-attach-remove").onclick = hideAttachBar;`,
    `  $("btn-attach-remove").onclick = hideAttachBar;

  // ── Загрузка файлов/изображений ──
  $("btn-attach-file").onclick = () => $("file-input").click();
  $("file-input").addEventListener("change", (e) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    handleFileAttachments(files);
    e.target.value = ""; // сброс чтобы можно было выбрать тот же файл
  });
  function handleFileAttachments(files) {
    for (const file of files) {
      if (file.type && file.type.startsWith("image/")) {
        // Картинка — как скриншот через paste
        const reader = new FileReader();
        reader.onload = () => {
          pendingImage = String(reader.result || "");
          $("attach-bar").classList.remove("hidden");
          $("attach-thumb").src = pendingImage;
          $("attach-name").textContent = "🖼 " + file.name;
        };
        reader.readAsDataURL(file);
        return; // только одна картинка за раз
      }
      // Текстовый файл — прочитать и вставить в поле ввода
      const reader = new FileReader();
      reader.onload = () => {
        const content = String(reader.result || "");
        const truncated = content.length > 30000 ? content.slice(0, 30000) + "\n\n... (обрезано)" : content;
        const tag = "[Содержимое " + file.name + "]:\n\`\`\`\n" + truncated + "\n\`\`\`\n\n";
        const input = $("input");
        input.value = input.value + tag;
        autoResize();
      };
      reader.readAsText(file);
    }
  }

  // ── Drag-and-drop файлов на поле ввода ──
  const composer = document.querySelector(".composer");
  let dragCounter = 0;
  composer.addEventListener("dragenter", (e) => { e.preventDefault(); dragCounter++; composer.classList.add("drag-over"); });
  composer.addEventListener("dragleave", (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; composer.classList.remove("drag-over"); } });
  composer.addEventListener("dragover", (e) => { e.preventDefault(); });
  composer.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    composer.classList.remove("drag-over");
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) handleFileAttachments(files);
  });`,
  ],

  // 3. После sendMessage → вызвать updateCtxIndicator
  // Найдём конец sendMessage (строка с hideAttachBar в sendMessage)
  [
    `    if (!chat) chat = createChat();`,
    `    if (!chat) chat = createChat();
    // Обновить индикатор контекста после отправки (после рендера)`,
  ],
  // Найдём рендер сообщений в sendMessage — обновим ctx после рендера
  [
    `    renderMessages();`,
    `    renderMessages();
    setTimeout(updateCtxIndicator, 100);`,
  ],

  // 4. При переключении чата тоже обновлять индикатор
  [
    `  function selectChat(id) {`,
    `  function selectChat(id) {
    // Обновить индикатор контекста при переключении чата`,
  ],
  [
    `  function selectChat(id) {
    // Обновить индикатор контекста при переключении чата
    if (streaming) return;
    chatsData.activeId = id;`,
    `  function selectChat(id) {
    if (streaming) return;
    chatsData.activeId = id;
    setTimeout(updateCtxIndicator, 100);`,
  ],
]);
