#!/usr/bin/env python3
"""app.js: кэш моделей + обвязка попапа модели, вставки изображений, переименования,
   Tab-дополнения терминала и ресайзера панели проекта."""
import io, sys

P = "src/renderer/app.js"
src = io.open(P, encoding="utf-8").read()

def apply(old, new, count=1, tag=""):
    global src
    n = src.count(old)
    if n != count:
        sys.exit(f"FAIL[{tag}]: ожидалось {count}, найдено {n} для: {old[:90]!r}")
    src = src.replace(old, new, count)

# 1. Кэш моделей в renderModelHints
apply(
    "  function renderModelHints(provider, models) {\n    const box = $(\"model-hints\");",
    "  function renderModelHints(provider, models) {\n    cachedModels[provider] = models || [];\n    const box = $(\"model-hints\");",
    tag="hints",
)

# 2. Бейдж модели: клик открывает попап; вне попапа — закрывает
apply(
    '  $("model-badge").onclick = openSettings;',
    '''  $("model-badge").onclick = toggleModelPopup;
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
  });''',
    tag="badge",
)

# 3. Вставка изображений + переименование чата
apply(
    '  $("input").addEventListener("input", autoResize);',
    '''  $("input").addEventListener("input", autoResize);
  $("input").addEventListener("paste", onInputPaste);
  $("btn-attach-remove").onclick = hideAttachBar;
  $("chat-title").addEventListener("dblclick", startRenameChat);''',
    tag="paste-rename",
)

# 4. Tab-дополнение в терминале (Enter/стрелки уже обрабатываются отдельно)
apply(
    '  $("term-input").addEventListener("keydown", (e) => {\n    if (e.key === "Enter") {',
    '''  $("term-input").addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      termTabComplete();
    } else if (e.key === "Enter") {''',
    tag="term-tab",
)

# 5. Ресайзер панели проекта (вертикальная полоска у левого края)
apply(
    "  // ── Секреты: переменные окружения ──",
    '''  // ── Ресайзер панели проекта: ширина перетаскиванием ──
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

  // ── Секреты: переменные окружения ──''',
    tag="panel-resize",
)

io.open(P, "w", encoding="utf-8", newline="\n").write(src)
print("OK — app.js: модели/изображения/переименование/Tab/ресайзер подключены")