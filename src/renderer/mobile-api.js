"use strict";
/* Мобильный доступ: когда интерфейс открыт через мост приложения (http://<ПК-IP>:9090),
   этот скрипт подключается по WebSocket к ядру на ПК и делает его полноценным:
   window.api (как в Electron), PIN-гейт при подключении, PWA (установка на главный экран).

   В Electron (window.api уже есть) и в веб-превью без моста (WS не поднимется) — no-op. */
(function () {
  if (window.api) return; // Electron: API уже предоставлен preload'ом
  if (location.protocol !== "http:" && location.protocol !== "https:") return;
  // Активен ТОЛЬКО когда страницу отдал мост приложения (src/mobile-bridge.js
  // подмешивает /bootstrap.js с флагом). В веб-превью (server.js) и Electron
  // этого флага нет — скрипт ничего не делает, мок-режим и preload не ломаются.
  if (!window.__mobileBridge) return;

  var WS_URL = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
  var ws = null;
  var authed = false;
  var enteredPin = "";
  var seq = 0;
  var pending = new Map(); // id → {resolve, reject}
  var queue = []; // вызовы до авторизации
  var listeners = {}; // channel → [cb]
  var gateEl = null;
  var pinInput = null;
  var gateErrorEl = null;
  var gateStatusEl = null;
  var reconnectTimer = null;
  var closed = false;
  var everOpened = false;

  // ─── Вызов канала (очередь до авторизации) ───
  function call(ch, args) {
    return new Promise(function (resolve, reject) {
      if (!authed) {
        queue.push({ ch: ch, args: args || [], resolve: resolve, reject: reject });
        return;
      }
      sendCall(ch, args || [], resolve, reject);
    });
  }

  function sendCall(ch, args, resolve, reject) {
    var id = ++seq;
    pending.set(id, { resolve: resolve, reject: reject });
    try {
      ws.send(JSON.stringify({ t: "call", id: id, ch: ch, args: args }));
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  }

  function flushQueue() {
    var q = queue;
    queue = [];
    for (var i = 0; i < q.length; i++) {
      var item = q[i];
      sendCall(item.ch, item.args, item.resolve, item.reject);
    }
  }

  function on(ch) {
    return function (cb) {
      (listeners[ch] = listeners[ch] || []).push(cb);
    };
  }

  function invoke(ch) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      return call(ch, args);
    };
  }

  // ─── API-поверхность (зеркало preload.js) ───
  window.api = {
    isElectron: true,
    getSettings: invoke("settings:get"),
    setSettings: invoke("settings:set"),
    loadChats: invoke("chats:load"),
    saveChats: invoke("chats:save"),
    sendMessage: invoke("ai:send"),
    answerQuestion: invoke("ai:answer"),
    undoStatus: invoke("undo:status"),
    undoRollback: invoke("undo:rollback"),
    stopMessage: invoke("ai:stop"),
    testConnection: invoke("ai:test"),
    listModels: invoke("ai:models"),
    pickDirectory: invoke("dialog:pickDir"),
    onAiEvent: on("ai:event"),

    githubDeviceStart: invoke("github:deviceStart"),
    githubDeviceCancel: invoke("github:deviceCancel"),
    githubDisconnect: invoke("github:disconnect"),
    githubUser: invoke("github:user"),
    onGithubEvent: on("github:event"),
    openExternal: invoke("shell:openExternal"),

    fsListTree: invoke("fs:listTree"),
    fsReadFile: invoke("fs:readFile"),
    fsReadImage: invoke("fs:readImage"),
    fsCreateFile: invoke("fs:createFile"),
    fsCreateFolder: invoke("fs:createFolder"),
    fsWriteFile: invoke("fs:writeFile"),
    fsDelete: invoke("fs:delete"),
    fsImportDropped: invoke("fs:importDropped"),
    fsPathForFile: function () {
      return "";
    },
    fsOpenInExplorer: invoke("fs:openInExplorer"),

    projectsList: invoke("projects:list"),
    projectsCreate: invoke("projects:create"),
    projectsActivate: invoke("projects:activate"),
    projectsRemove: invoke("projects:remove"),

    gitRepoInfo: invoke("git:repoInfo"),
    gitStatus: invoke("git:status"),
    gitLog: invoke("git:log"),
    gitCommitDetail: invoke("git:commitDetail"),
    gitRevert: invoke("git:revert"),
    gitResetHard: invoke("git:resetHard"),
    gitRestore: invoke("git:restore"),
    gitUndoLastCommit: invoke("git:undoLastCommit"),
    gitClone: invoke("git:clone"),
    gitDiff: invoke("git:diff"),
    gitCommit: invoke("git:commit"),
    gitPush: invoke("git:push"),

    githubPickRepo: invoke("github:pickRepo"),
    githubRepos: invoke("github:repos"),
    githubSelectRepo: invoke("github:selectRepo"),
    githubSelectedRepo: invoke("github:selectedRepo"),
    githubUnselectRepo: invoke("github:unselectRepo"),
    githubPublish: invoke("github:publish"),

    termStart: invoke("term:start"),
    termInput: invoke("term:input"),
    termStop: invoke("term:stop"),
    termStatus: invoke("term:status"),
    termComplete: invoke("term:complete"),
    onTermEvent: on("term:event"),

    devStart: invoke("dev:start"),
    devStop: invoke("dev:stop"),
    devStatus: invoke("dev:status"),
    onDevEvent: on("dev:event"),

    mobileStatus: invoke("mobile:status"),
    mobilePinRegen: invoke("mobile:pinRegen"),
  };

  // Хост моста: для превью-адресов вида http://localhost:5000 подставляем IP ПК.
  window.mobileApi = { host: location.host, connected: false };

  // ─── PIN-гейт ───
  function showGate() {
    if (gateEl) return;
    gateEl = document.createElement("div");
    gateEl.id = "mobile-gate";
    gateEl.style.cssText =
      "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;" +
      "background:radial-gradient(1200px 600px at 50% -10%,rgba(14,165,233,.18),transparent 60%),#0b0f1a;" +
      "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#e6edf7;";
    gateEl.innerHTML =
      '<div style="width:min(88vw,360px);background:linear-gradient(180deg,rgba(20,26,48,.96),rgba(10,14,28,.98));' +
      "border:1px solid rgba(120,170,255,.25);border-radius:22px;padding:28px 24px 22px;box-shadow:0 30px 80px rgba(0,0,0,.6);" +
      'text-align:center;">' +
      '<div style="font-size:40px;line-height:1;margin-bottom:10px;">🤖</div>' +
      '<h2 style="margin:0 0 6px;font-size:20px;font-weight:700;letter-spacing:.2px;">AI Developer Agent</h2>' +
      '<p style="margin:0 0 18px;font-size:13px;color:#93a4c2;line-height:1.5;">Подключение к твоему ПК.<br/>Введи PIN из Настроек приложения → «Мобильный доступ».</p>' +
      '<input id="mobile-pin" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="6" placeholder="••••••"' +
      ' style="width:100%;box-sizing:border-box;text-align:center;font-size:26px;letter-spacing:12px;padding:12px 8px;border-radius:14px;' +
      "border:1px solid rgba(120,170,255,.35);background:rgba(6,10,22,.85);color:#dff3ff;outline:none;" +
      ' />' +
      '<div id="mobile-gate-err" style="min-height:20px;margin-top:10px;font-size:13px;color:#ff7b8a;"></div>' +
      '<button id="mobile-gate-btn" style="width:100%;margin-top:4px;padding:12px;border:none;border-radius:14px;cursor:pointer;' +
      "background:linear-gradient(90deg,#0891b2,#6366f1);color:#fff;font-size:15px;font-weight:700;box-shadow:0 8px 24px rgba(99,102,241,.4);" +
      '">Подключиться</button>' +
      '<div id="mobile-gate-status" style="margin-top:14px;font-size:12px;color:#5b6b8c;"></div>' +
      "</div>";
    document.body.appendChild(gateEl);
    pinInput = gateEl.querySelector("#mobile-pin");
    gateErrorEl = gateEl.querySelector("#mobile-gate-err");
    gateStatusEl = gateEl.querySelector("#mobile-gate-status");
    var btn = gateEl.querySelector("#mobile-gate-btn");
    function tryAuth() {
      var v = (pinInput.value || "").trim();
      if (v.length < 4) {
        gateErrorEl.textContent = "PIN — минимум 4 цифры.";
        return;
      }
      enteredPin = v;
      gateErrorEl.textContent = "";
      gateStatusEl.textContent = "Проверяю PIN...";
      try {
        ws.send(JSON.stringify({ t: "auth", pin: v }));
      } catch (e) {
        gateStatusEl.textContent = "Соединение не установлено. Пробую снова...";
      }
    }
    btn.onclick = tryAuth;
    pinInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") tryAuth();
    });
    setTimeout(function () {
      if (pinInput) pinInput.focus();
    }, 100);
  }

  function hideGate() {
    if (gateEl) {
      gateEl.parentNode && gateEl.parentNode.removeChild(gateEl);
      gateEl = null;
      pinInput = null;
      gateErrorEl = null;
      gateStatusEl = null;
    }
  }

  function gateError(msg) {
    if (gateStatusEl) gateStatusEl.textContent = "";
    if (gateErrorEl) gateErrorEl.textContent = msg;
  }

  // ─── WebSocket ───
  function connect() {
    if (closed) return;
    clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = function () {
      everOpened = true;
      if (enteredPin) {
        try {
          ws.send(JSON.stringify({ t: "auth", pin: enteredPin }));
        } catch {}
      } else {
        showGate();
        if (gateStatusEl) gateStatusEl.textContent = "Соединение с ПК установлено. Введи PIN.";
      }
    };
    ws.onmessage = function (e) {
      var m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!m) return;
      if (m.t === "auth_ok") {
        authed = true;
        window.mobileApi.connected = true;
        hideGate();
        flushQueue();
        registerSw();
      } else if (m.t === "auth_err") {
        authed = false;
        if (gateErrorEl) gateErrorEl.textContent = "Неверный PIN. Попробуй ещё раз.";
      } else if (m.t === "auth_lock") {
        authed = false;
        gateError("Слишком много неверных попыток. Переподключение...");
      } else if (m.t === "res") {
        var p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          if (m.ok) p.resolve(m.v);
          else p.reject(new Error(m.e || "Ошибка вызова"));
        }
      } else if (m.t === "ev") {
        var cbs = listeners[m.ch];
        if (cbs) {
          for (var i = 0; i < cbs.length; i++) {
            try {
              cbs[i](m.v);
            } catch {}
          }
        }
      }
    };
    ws.onclose = function () {
      var wasAuthed = authed;
      authed = false;
      window.mobileApi.connected = false;
      // Все зависшие вызовы — отклоняем (соединение упало).
      var pend = pending;
      pending = new Map();
      pend.forEach(function (p) {
        p.reject(new Error("Соединение с ПК потеряно"));
      });
      if (wasAuthed) {
        showGate();
        if (gateStatusEl) gateStatusEl.textContent = "Соединение потеряно. Введи PIN заново.";
      }
      // Моста здесь нет (веб-превью без приложения) — не крутим вечный цикл переподключения.
      if (everOpened || gateEl) scheduleReconnect();
    };
    ws.onerror = function () {
      try {
        ws.close();
      } catch {}
    };
  }

  function scheduleReconnect() {
    if (closed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500);
  }

  function registerSw() {
    try {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/sw.js").catch(function () {});
      }
    } catch {}
  }

  connect();
})();