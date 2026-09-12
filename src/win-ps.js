"use strict";
// ── Живая сессия PowerShell (ускорение №5) ─────────────────────────────────
// Обычный вызов `powershell.exe -NoProfile -NonInteractive -Command "..."` — это
// ХОЛОДНЫЙ старт .NET и модулей: 0,4–1,5 с на каждую системную справку
// (getSystemInfo, registryRead, refreshEnv). Агент платит это каждый раз.
//
// Здесь ровно один долгоживущий процесс: он читает base64-скрипты из stdin и
// печатает результат между маркерами (иначе не отличить вывод скрипта от
// служебных строк). Перед первой настоящей командой сессия проходит короткое
// РУКОПОЖАТИЕ: если обёртка почему-то не работает, приложение немедленно
// переходит на прежний разовый запуск и больше не тратит время на попытки.
// Любой сбой — { noSession: true }; поведение инструментов не меняется.

const BEGIN = "__AI_PS_BEGIN__";
const END = "__AI_PS_END__";
const EXIT = "__AI_PS_EXIT__";
const HANDSHAKE = "__AI_PS_READY__";
const IDLE_MS = 5 * 60 * 1000; // столько сессия живёт без работы
const HANDSHAKE_MS = 6000; // рукопожатие: холодный старт + мгновенный ответ
const BROKEN_MS = 5 * 60 * 1000; // после провала не пробуем снова 5 минут
const DEFAULT_TIMEOUT = 30000;

// Обёртка (уходит через -EncodedCommand): цикл чтения команд из stdin.
const WRAPPER = [
  "$ErrorActionPreference = 'Continue'",
  "try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  if ($line -eq '" + EXIT + "') { break }",
  "  $src = ''",
  "  try { $src = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) } catch { }",
  "  $out = ''",
  "  $code = 0",
  "  $global:LASTEXITCODE = 0",
  "  try {",
  "    $sb = [ScriptBlock]::Create($src)",
  "    $out = (& $sb *>&1 | Out-String)",
  "    if ($null -ne $LASTEXITCODE) { $code = [int]$LASTEXITCODE }",
  "  } catch {",
  "    $out = [string]$_.Exception.Message",
  "    $code = 1",
  "  }",
  "  [Console]::Out.WriteLine('" + BEGIN + "')",
  "  [Console]::Out.Write([string]$out)",
  "  [Console]::Out.WriteLine('')",
  "  [Console]::Out.WriteLine('" + END + "' + $code)",
  "  [Console]::Out.Flush()",
  "}",
].join("\n");

let spawnImpl = (file, args, opts) => require("child_process").spawn(file, args, opts);
let platformImpl = () => process.platform;

let child = null;
let buf = "";
let pending = null;
let idleTimer = null;
let brokenUntil = 0; // до этого момента сессию не поднимаем
let brokenCount = 0; // чем больше провалов, тем дольше не пробуем снова
let chain = Promise.resolve();

function wrapperEncoded() {
  return Buffer.from(WRAPPER, "utf16le").toString("base64");
}

// Провал рукопожатия: не тратим секунды на повторные попытки (5 мин → 20 мин → 1 ч).
function markBroken() {
  brokenCount++;
  const backoff = Math.min(BROKEN_MS * brokenCount * brokenCount, 60 * 60 * 1000);
  brokenUntil = Date.now() + backoff;
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => shutdown(), IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function failPending(reason) {
  const p = pending;
  pending = null;
  buf = "";
  if (!p) return;
  clearTimeout(p.timer);
  p.resolve({ ok: false, code: -1, out: "", err: reason, noSession: true });
}

function drain() {
  if (!pending) {
    if (buf.length > 8192) buf = ""; // чужой вывод (например, из умершей команды)
    return;
  }
  const bi = buf.indexOf(BEGIN);
  if (bi < 0) return;
  const ei = buf.indexOf(END, bi + BEGIN.length);
  if (ei < 0) return;
  const out = buf.slice(bi + BEGIN.length, ei).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  const rest = buf.slice(ei + END.length);
  const m = rest.match(/-?\d+/);
  const code = m ? parseInt(m[0], 10) : 0;
  const p = pending;
  pending = null;
  buf = "";
  clearTimeout(p.timer);
  p.resolve({ ok: code === 0, code, out, err: "" });
  armIdle();
}

function start() {
  if (child) return child;
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", wrapperEncoded()];
  const c = spawnImpl("powershell.exe", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  if (!c || !c.stdin || !c.stdout) throw new Error("не удалось запустить powershell.exe");
  child = c;
  buf = "";
  if (c.stdout.setEncoding) c.stdout.setEncoding("utf8");
  c.stdout.on("data", (d) => {
    buf += typeof d === "string" ? d : String(d);
    drain();
  });
  if (c.stderr && c.stderr.on) c.stderr.on("data", () => {});
  const dead = () => {
    if (child === c) child = null;
    failPending("сессия PowerShell завершилась");
  };
  if (c.on) {
    c.on("exit", dead);
    c.on("close", dead);
    c.on("error", dead);
  }
  // Сессия не должна держать приложение живым при выходе.
  if (c.unref) {
    try {
      c.unref();
    } catch (e) {}
  }
  armIdle();
  return c;
}

// Отправить скрипт в уже открытую сессию и дождаться маркеров.
function send(script, timeoutMs) {
  const c = child;
  if (!c) {
    return Promise.resolve({ ok: false, code: -1, out: "", err: "сессия недоступна", noSession: true });
  }
  return new Promise((resolve) => {
    const ms = Math.max(1000, parseInt(timeoutMs, 10) || DEFAULT_TIMEOUT);
    const timer = setTimeout(() => {
      pending = null;
      buf = "";
      shutdown();
      resolve({ ok: false, code: -1, out: "", err: "таймаут PowerShell (" + ms + " мс)", noSession: true });
    }, ms);
    pending = { resolve, timer };
    try {
      c.stdin.write(Buffer.from(String(script == null ? "" : script), "utf8").toString("base64") + "\n");
    } catch (e) {
      const p = pending;
      pending = null;
      clearTimeout(timer);
      const payload = {
        ok: false,
        code: -1,
        out: "",
        err: "не удалось отправить скрипт в PowerShell: " + ((e && e.message) || e),
        noSession: true,
      };
      if (p) p.resolve(payload);
      else resolve(payload);
    }
  });
}

function down(what) {
  return { ok: false, code: -1, out: "", err: what, noSession: true };
}

async function execOne(script, opts) {
  const o = opts || {};
  if (platformImpl() !== "win32") return down("не Windows");
  if (Date.now() < brokenUntil) return down("живая сессия PowerShell помечена как нерабочая — разовый запуск");
  let c = null;
  try {
    c = start();
  } catch (e) {
    markBroken();
    return down("PowerShell-сессия не запустилась: " + ((e && e.message) || e));
  }
  // Рукопожатие: сессия должна один раз доказать, что обёртка работает.
  if (!c.__aiVerified) {
    const hs = await send("'" + HANDSHAKE + "'", HANDSHAKE_MS);
    if (!hs.ok || String(hs.out || "").indexOf(HANDSHAKE) === -1) {
      shutdown();
      markBroken();
      return down("живая сессия PowerShell не подтвердилась (" + (hs.err || "нет ответа") + ") — работаем разовыми запусками");
    }
    c.__aiVerified = true;
    brokenCount = 0;
  }
  return send(script, o.timeoutMs);
}

// Последовательная очередь: в сессии одна команда за раз.
function exec(script, opts) {
  const run = () => execOne(script, opts);
  const p = chain.then(run, run);
  chain = p.then(
    () => {},
    () => {}
  );
  return p;
}

function shutdown() {
  failPending("сессия остановлена");
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const c = child;
  child = null;
  buf = "";
  if (!c) return;
  try {
    if (c.stdin && c.stdin.writable) c.stdin.write(EXIT + "\n");
  } catch (e) {}
  try {
    if (c.kill) c.kill();
  } catch (e) {}
}

function isRunning() {
  return !!child;
}

module.exports = {
  exec,
  shutdown,
  isRunning,
  // ── для тестов ──
  __setSpawnForTests(fn) {
    spawnImpl = fn || ((file, args, opts) => require("child_process").spawn(file, args, opts));
  },
  __setPlatformForTests(fn) {
    platformImpl = fn || (() => process.platform);
  },
  __markers() {
    return { BEGIN, END, EXIT, HANDSHAKE };
  },
  __wrapperScript() {
    return WRAPPER;
  },
};
