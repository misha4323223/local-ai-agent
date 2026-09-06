#!/usr/bin/env python3
"""main.js: импорт Notification, termComplete (автодополнение терминала) + IPC,
   системное уведомление при завершении ответа агента вне фокуса."""
import io, sys

P = "src/main.js"
src = io.open(P, encoding="utf-8").read()

def apply(old, new, count=1, tag=""):
    global src
    n = src.count(old)
    if n != count:
        sys.exit(f"FAIL[{tag}]: ожидалось {count}, найдено {n} для: {old[:90]!r}")
    src = src.replace(old, new, count)

# 1. Импорт Notification
apply(
    'const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");',
    'const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require("electron");',
    tag="import",
)

# 2. termComplete — перед секцией IPC (после termStop)
apply(
    """function termStop() {
  if (!userTerm) return { ok: false, error: "Терминал не запущен" };
  const rec = userTerm;
  userTerm = null;
  bgKill(rec);
  return { ok: true };
}

// ─────────────────────────── IPC ───────────────────────────""",
    """function termStop() {
  if (!userTerm) return { ok: false, error: "Терминал не запущен" };
  const rec = userTerm;
  userTerm = null;
  bgKill(rec);
  return { ok: true };
}

// Автодополнение команды в терминале (Tab): команды из PATH или файлы рабочей папки.
function termComplete(line) {
  const text = String(line || "");
  const cwd = agentWorkDir(loadSettings());
  const sp = text.lastIndexOf(" ");
  const token = sp >= 0 ? text.slice(sp + 1) : text;
  const base = sp >= 0 ? text.slice(0, sp + 1) : "";
  const matches = [];
  const listDir = (dir, prefix, fullPrefix) => {
    try {
      for (const e of fs.readdirSync(dir)) {
        if (!e.startsWith(prefix)) continue;
        let isDir = false;
        try { isDir = fs.statSync(path.join(dir, e)).isDirectory(); } catch {}
        matches.push(fullPrefix + e + (isDir ? "/" : ""));
      }
    } catch {}
  };
  if (!token) {
    listDir(cwd, "", ""); // пустой токен — файлы рабочей папки
  } else if (token.includes("/") || token.startsWith(".")) {
    const isAbs = path.isAbsolute(token);
    const slash = token.lastIndexOf("/");
    const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
    const filePart = slash >= 0 ? token.slice(slash + 1) : token;
    const searchDir = isAbs ? (dirPart || "/") : path.join(cwd, dirPart);
    listDir(searchDir, filePart, dirPart);
  } else {
    const pathDirs = (process.env.PATH || "").split(path.delimiter);
    for (const d of pathDirs) {
      try {
        for (const e of fs.readdirSync(d)) {
          if (e.toLowerCase().startsWith(token.toLowerCase())) matches.push(e);
        }
      } catch {}
    }
  }
  return { matches: [...new Set(matches)].sort().slice(0, 30), base, tokenLen: token.length };
}

// ─────────────────────────── IPC ───────────────────────────""",
    tag="termcomplete",
)

# 3. IPC term:complete — после term:status
apply(
    'ipcMain.handle("term:status", () => ({ running: !!(userTerm && !userTerm.exited) }));',
    'ipcMain.handle("term:status", () => ({ running: !!(userTerm && !userTerm.exited) }));\nipcMain.handle("term:complete", (_e, line) => termComplete(line));',
    tag="ipc",
)

# 4. Уведомление при завершении ответа, если окно не в фокусе
apply(
    """      if (toolCalls.length === 0) {
      lastUndoLog = activeRunUndo.slice();
      persistUndo();
      if (lastUndoLog.length) emit({ type: "undo_available", count: lastUndoLog.length });
      emit({ type: "done" });
      return { ok: true, text: finalText };""",
    """      if (toolCalls.length === 0) {
      lastUndoLog = activeRunUndo.slice();
      persistUndo();
      if (lastUndoLog.length) emit({ type: "undo_available", count: lastUndoLog.length });
      // Системное уведомление, если окно не в фокусе (долгий ответ закончился)
      if (mainWindow && !mainWindow.isFocused() && Notification.isSupported()) {
        try {
          const snippet = String(finalText || "").trim().slice(0, 140);
          new Notification({
            title: "AI Developer Agent",
            body: "Ответ агента готов" + (snippet ? ": " + snippet : ""),
          }).show();
        } catch {}
      }
      emit({ type: "done" });
      return { ok: true, text: finalText };""",
    tag="notify",
)

io.open(P, "w", encoding="utf-8", newline="\n").write(src)
print("OK — main.js: уведомление и автодополнение терминала добавлены")