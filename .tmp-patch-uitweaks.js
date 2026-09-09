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

// ═══════════════════════════════════════════
// 1) CSS: зафиксировать #messages + чекбоксы
// ═══════════════════════════════════════════
patch("src/renderer/styles.css", [
  // messages: min-height:0 чтобы flex корректно ограничивал высоту
  [
    "#messages {\n  flex: 1; overflow-y: auto; padding: 24px 8%;",
    "#messages {\n  flex: 1; min-height: 0; overflow-y: auto; padding: 24px 8%;",
  ],
  // input-bar: фиксированный снизу
  [
    "#input-bar { padding: 8px 8% 14px; border-top: 1px solid var(--border-soft); }",
    "#input-bar { padding: 8px 8% 14px; border-top: 1px solid var(--border-soft); flex-shrink: 0; }",
  ],
  // Чекбоксы и тулбар для панели изменений
  [
    ".change-commit { display: flex; gap: 6px; }",
    "/* ─── Чекбоксы в панели изменений ─── */\n.change-select-row { display: flex; align-items: center; gap: 8px; padding: 0 0 6px; border-bottom: 1px solid rgba(255,255,255,0.05); margin-bottom: 4px; }\n.change-select-row label { font-size: 11px; color: var(--text-faint); cursor: pointer; user-select: none; }\n.change-actions-bar { display: none; gap: 6px; padding: 6px 0; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.05); }\n.change-actions-bar.visible { display: flex; }\n.change-actions-bar .btn { font-size: 11px; padding: 4px 10px; }\n.change-item { display: flex; align-items: center; gap: 8px; }\n.change-item input[type=\"checkbox\"] { width: 14px; height: 14px; accent-color: var(--accent); cursor: pointer; flex-shrink: 0; }\n.change-commit { display: flex; gap: 6px; }",
  ],
]);

// ═══════════════════════════════════════════
// 2) HTML: добавить тулбар массового удаления в panel-changes
// ═══════════════════════════════════════════
patch("src/renderer/index.html", [
  [
    "        <div id=\"change-list\" class=\"change-list\"></div>",
    "        <div id=\"change-select-bar\" class=\"change-select-row\">\n          <input type=\"checkbox\" id=\"change-select-all\" title=\"Выбрать все\" />\n          <label for=\"change-select-all\">Выбрать все</label>\n        </div>\n        <div id=\"change-actions-bar\" class=\"change-actions-bar\">\n          <button id=\"btn-unstage-selected\" class=\"btn btn-ghost btn-small\" title=\"Убрать из индекса (git reset HEAD)\">↩ Убрать из staged</button>\n          <button id=\"btn-untrack-selected\" class=\"btn btn-danger btn-small\" title=\"Удалить из git и с диска (git rm)\">🗑 Удалить выбранные</button>\n        </div>\n        <div id=\"change-list\" class=\"change-list\"></div>",
  ],
]);

// ═══════════════════════════════════════════
// 3) JS: логика чекбоксов + массового удаления
// ═══════════════════════════════════════════
// Найдём конец refreshChanges и добавим чекбоксы + selectAll + actions
patch("src/renderer/app.js", [
  // Добавить selectedFiles переменную рядом с panelTab
  [
    "  let panelTab = \"files\";",
    "  let panelTab = \"files\";\n  const selectedChanges = new Set(); // выбранные файлы для массовых операций",
  ],
  // Переписать конец refreshChanges — добавить чекбоксы
  [
    `      row.title = "Клик — показать дифф";
        row.onclick = () => showDiff(repoRoot, f);
        listEl.appendChild(row);`,
    `      row.title = "Клик — показать дифф";
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
        listEl.appendChild(row);`,
  ],
  // После цикла for groups — вызвать updateChangeActions
  [
    `    }
  }

  // Показ диффа/содержимого файла в оверлее`,
    `    }
    updateChangeActions();

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

  // Показ диффа/содержимого файла в оверлее`,
  ],
]);
