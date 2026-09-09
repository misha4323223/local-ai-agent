"use strict";
const fs = require("fs");
const path = require("path");

const FILE = "src/renderer/app.js";
let src = fs.readFileSync(FILE, "utf8");

// STEP 1: Remove the incorrectly placed block (wrong nesting level)
// The block starts right after the for-groups closing braces and ends before "Показ диффа"
const BAD_BLOCK_START = `    updateChangeActions();\n\n  // ── Чекбоксы: выбор / снятие ──\n  function toggleChangeSelect(file, checked) {\n    if (checked) selectedChanges.add(file); else selectedChanges.delete(file);\n    updateChangeActions();\n  }\n  function updateChangeActions() {`;
const BAD_BLOCK_END = `  };\n\n  // Показ диффа/содержимого файла в оверлее`;

// Find and remove the bad block — it was inserted at wrong nesting level
const badStartIdx = src.indexOf(BAD_BLOCK_START);
if (badStartIdx === -1) { console.error("BAD_BLOCK_START not found"); process.exit(1); }

const badEndIdx = src.indexOf(BAD_BLOCK_END, badStartIdx);
if (badEndIdx === -1) { console.error("BAD_BLOCK_END not found"); process.exit(1); }

// Remove the bad block (from updateChangeActions to before "Показ диффа")
src = src.slice(0, badStartIdx) + src.slice(badEndIdx);
console.log("Removed bad block at wrong nesting level");

// STEP 2: Insert the functions at the CORRECT level
// Find the right spot: after the "showDiff" function and before the next section
// Actually, we need to place them right before showDiff but at depth 2 level

// Find "// Показ диффа/содержимого файла в оверлее"
const SHOW_DIFF_MARKER = "  // Показ диффа/содержимого файла в оверлее";
const showDiffIdx = src.indexOf(SHOW_DIFF_MARKER);
if (showDiffIdx === -1) { console.error("SHOW_DIFF_MARKER not found"); process.exit(1); }

// Insert the functions BEFORE the showDiff comment at the correct depth (2 spaces)
const FUNCTIONS_BLOCK = `  // ── Чекбоксы: выбор / снятие ──\n  function toggleChangeSelect(file, checked) {\n    if (checked) selectedChanges.add(file); else selectedChanges.delete(file);\n    updateChangeActions();\n  }\n  function updateChangeActions() {\n    const bar = $("change-actions-bar");\n    bar.classList.toggle("visible", selectedChanges.size > 0);\n    // Обновить счётчик в кнопках\n    const n = selectedChanges.size;\n    const btnUnstage = $("btn-unstage-selected");\n    const btnDel = $("btn-untrack-selected");\n    btnUnstage.textContent = "↩ Убрать из staged" + (n ? " (" + n + ")" : "");\n    btnDel.textContent = "🗑 Удалить выбранные" + (n ? " (" + n + ")" : "");\n    // Select all checkbox\n    const all = document.querySelectorAll(".change-cb");\n    const selAll = $("change-select-all");\n    if (all.length) selAll.checked = Array.from(all).every((cb) => cb.checked);\n  }\n\n  // ── Выбрать все / снять все ──\n  $("change-select-all").onclick = () => {\n    const checked = $("change-select-all").checked;\n    document.querySelectorAll(".change-cb").forEach((cb) => {\n      cb.checked = checked;\n      const f = cb.dataset.file;\n      if (checked) selectedChanges.add(f); else selectedChanges.delete(f);\n    });\n    updateChangeActions();\n  };\n\n  // ── Убрать из staged ──\n  $("btn-unstage-selected").onclick = async () => {\n    if (!repoRoot || !selectedChanges.size) return;\n    for (const f of selectedChanges) {\n      await api.runCommand("git reset HEAD -- " + JSON.stringify(f), repoRoot);\n    }\n    selectedChanges.clear();\n    refreshChanges();\n  };\n\n  // ── Удалить выбранные ──\n  $("btn-untrack-selected").onclick = async () => {\n    if (!repoRoot || !selectedChanges.size) return;\n    const files = [...selectedChanges];\n    confirmModal(\n      "Удалить " + files.length + " файл(ов)?",\n      "Файлы будут удалены с диска и из git. Это необратимо.",\n      async () => {\n        for (const f of files) {\n          await api.runCommand("git rm -f " + JSON.stringify(f), repoRoot);\n        }\n        selectedChanges.clear();\n        refreshChanges();\n      }\n    );\n  };\n\n`;

src = src.slice(0, showDiffIdx) + FUNCTIONS_BLOCK + src.slice(showDiffIdx);

// STEP 3: Fix the "updateChangeActions();" call that was left orphaned after for-groups
// It should be inside refreshChanges, after the for-groups loop closes
// Currently there should be a stray "updateChangeActions();" after the for loops
// Let's check: it should appear once in toggleChangeSelect and once after the for loop
// Actually let's just verify depth
let depth = 0;
for (let i = 0; i < src.length; i++) {
  if (src[i] === '{') depth++;
  if (src[i] === '}') depth--;
}
console.log("Final depth:", depth);

if (depth !== 0) {
  console.error("Depth still wrong:", depth);
  process.exit(1);
}

fs.writeFileSync(FILE, src, "utf8");
console.log("Fixed " + FILE);
