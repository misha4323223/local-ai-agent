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
  var gateBusy = false;
  var gateAutoTimer = null;
  var gateViewportBound = false;
  var gateHost = location.host || "";

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
  /* Оформление страницы входа: один инжектируемый <style>, без inline-стилей.
     Плоская монохромная тема — как monochrome.css в приложении (там же 
     глобально выключены тени и градиенты). Ключевое — высота и прокрутка
     по visualViewport: на телефоне клавиатура перекрывает низ экрана, и
     фиксированная центрированная карточка «прятала» кнопку «Подключиться».
     Теперь карточка центрируется через margin:auto в скроллируемом контейнере
     и потому остаётся доступной при любой высоте видимой области. */
  var GATE_CSS = [
    "#mobile-gate{position:fixed;left:0;right:0;top:0;z-index:99999;overflow:auto;-webkit-overflow-scrolling:touch;",
    "background:#0a0a0b;color:#f4f4f5;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;",
    "font-size:15px;line-height:1.4;-webkit-text-size-adjust:100%;}",
    "#mobile-gate .mg-wrap{display:flex;min-height:100%;box-sizing:border-box;",
    "padding:max(12px,env(safe-area-inset-top)) 16px max(14px,env(safe-area-inset-bottom));}",
    "#mobile-gate .mg-card{margin:auto;width:min(100%,340px);box-sizing:border-box;",
    "background:#141417;border:1px solid #2b2b30;border-radius:18px;padding:16px 15px 12px;}",
    "#mobile-gate .mg-top{display:flex;align-items:center;gap:10px;margin-bottom:12px;}",
    "#mobile-gate .mg-logo{flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:#f4f4f5;color:#0a0a0b;",
    "display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;}",
    "#mobile-gate .mg-name{font-size:14.5px;font-weight:600;letter-spacing:.1px;}",
    "#mobile-gate .mg-sub{font-size:11.5px;color:#a3a3ab;margin-top:2px;}",
    "#mobile-gate .mg-pin{display:block;width:100%;box-sizing:border-box;text-align:center;",
    "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:23px;font-weight:600;",
    "letter-spacing:.3em;text-indent:.3em;padding:10px 6px;border-radius:12px;border:1px solid #2b2b30;",
    "background:#0d0d0f;color:#f4f4f5;outline:none;-webkit-appearance:none;appearance:none;}",
    "#mobile-gate .mg-pin::placeholder{color:#45454d;}",
    "#mobile-gate .mg-pin:focus{border-color:#f4f4f5;}",
    "#mobile-gate .mg-err{min-height:15px;margin-top:7px;font-size:12px;color:#ff6b6b;}",
    "#mobile-gate .mg-btn{display:block;width:100%;margin-top:5px;padding:13px;border:none;border-radius:12px;",
    "cursor:pointer;background:#f4f4f5;color:#0a0a0b;font-size:15px;font-weight:600;font-family:inherit;",
    "touch-action:manipulation;-webkit-tap-highlight-color:transparent;}",
    "#mobile-gate .mg-btn:active{background:#fff;}",
    "#mobile-gate .mg-btn:disabled{opacity:.5;}",
    "#mobile-gate .mg-status{min-height:15px;margin-top:9px;font-size:11.5px;color:#6d6d75;}",
    "#mobile-gate .mg-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;",
    "margin-top:6px;font-size:11px;color:#6d6d75;}",
    "#mobile-gate .mg-host{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    "#mobile-gate .mg-link{background:none;border:none;padding:4px 0;color:#a3a3ab;font-size:11px;",
    "font-family:inherit;text-decoration:underline;cursor:pointer;touch-action:manipulation;}",
    "@media (max-height:430px){#mobile-gate .mg-card{margin:auto auto 0;}}",
    "#mobile-gate.hide{display:none;}",
  ].join("");

  function ensureGateStyle() {
    if (document.getElementById("mobile-gate-css")) return;
    var st = document.createElement("style");
    st.id = "mobile-gate-css";
    st.textContent = GATE_CSS;
    document.head.appendChild(st);
  }

  // Видимая область меняется при появлении клавиатуры — подгоняем высоту
  // карточки-оверлея, иначе поле ввода и кнопка уезжают под клавиатуру.
  function syncGateViewport() {
    if (!gateEl) return;
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight || document.documentElement.clientHeight;
    gateEl.style.height = Math.round(h) + "px";
    gateEl.style.top = Math.round(vv ? vv.offsetTop : 0) + "px";
  }

  function bindGateViewport() {
    if (gateViewportBound) return;
    gateViewportBound = true;
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncGateViewport);
      window.visualViewport.addEventListener("scroll", syncGateViewport);
    }
    window.addEventListener("resize", syncGateViewport);
    window.addEventListener("orientationchange", syncGateViewport);
  }

  function unbindGateViewport() {
    if (!gateViewportBound) return;
    gateViewportBound = false;
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", syncGateViewport);
      window.visualViewport.removeEventListener("scroll", syncGateViewport);
    }
    window.removeEventListener("resize", syncGateViewport);
    window.removeEventListener("orientationchange", syncGateViewport);
  }

  function setGateBusy(on, label) {
    gateBusy = !!on;
    if (!gateEl) return;
    var btn = gateEl.querySelector("#mobile-gate-btn");
    if (!btn) return;
    btn.disabled = gateBusy;
    btn.textContent = gateBusy ? label || "Подключаюсь…" : "Подключиться";
  }

  function gateStatus(msg) {
    if (gateStatusEl) gateStatusEl.textContent = msg || "";
  }

  function showGate() {
    if (gateEl) return;
    ensureGateStyle();
    gateEl = document.createElement("div");
    gateEl.id = "mobile-gate";
    gateEl.innerHTML = [
      '<div class="mg-wrap"><div class="mg-card">',
      '<div class="mg-top"><div class="mg-logo">A</div><div>',
      '<div class="mg-name">AI Developer Agent</div>',
      '<div class="mg-sub">PIN из Настроек на ПК → «Мобильный доступ»</div>',
      "</div></div>",
      '<input id="mobile-pin" class="mg-pin" type="tel" inputmode="numeric" pattern="[0-9]*"',
      ' autocomplete="one-time-code" enterkeyhint="go" maxlength="6" placeholder="······" aria-label="PIN" />',
      '<div id="mobile-gate-err" class="mg-err"></div>',
      '<button id="mobile-gate-btn" class="mg-btn" type="button">Подключиться</button>',
      '<div id="mobile-gate-status" class="mg-status"></div>',
      '<div class="mg-foot"><span class="mg-host"></span>',
      '<button id="mobile-gate-retry" class="mg-link" type="button">Переподключиться</button></div>',
      "</div></div>",
    ].join("");
    document.body.appendChild(gateEl);
    pinInput = gateEl.querySelector("#mobile-pin");
    gateErrorEl = gateEl.querySelector("#mobile-gate-err");
    gateStatusEl = gateEl.querySelector("#mobile-gate-status");
    var hostEl = gateEl.querySelector(".mg-host");
    if (hostEl) hostEl.textContent = "ПК: " + gateHost;
    var btn = gateEl.querySelector("#mobile-gate-btn");
    var retryBtn = gateEl.querySelector("#mobile-gate-retry");

    function tryAuth() {
      if (gateBusy) return;
      var v = String(pinInput.value || "").replace(/\D+/g, "");
      if (v.length < 4) {
        gateError("PIN — минимум 4 цифры.");
        return;
      }
      enteredPin = v;
      gateError("");
      if (!ws || ws.readyState === 3) {
        // Мост не отвечает: подключение могло отвалиться (сменился Wi-Fi).
        gateStatus("Нет связи с ПК. Переподключаюсь…");
        setGateBusy(false);
        connect();
        return;
      }
      if (ws.readyState === 0) {
        setGateBusy(true, "Соединяюсь…");
        gateStatus("PIN отправится сразу после соединения.");
        return;
      }
      setGateBusy(true, "Проверяю PIN…");
      gateStatus("");
      try {
        ws.send(JSON.stringify({ t: "auth", pin: v }));
      } catch (e) {
        setGateBusy(false);
        gateStatus("Соединение не установлено. Пробую снова…");
      }
    }

    btn.onclick = tryAuth;
    if (retryBtn) {
      retryBtn.onclick = function () {
        setGateBusy(false);
        gateStatus("Переподключаюсь к ПК…");
        try {
          if (ws) ws.close();
        } catch (e) {}
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 60);
      };
    }
    pinInput.addEventListener("input", function () {
      var digits = String(pinInput.value || "").replace(/\D+/g, "").slice(0, 6);
      if (digits !== pinInput.value) pinInput.value = digits;
      if (gateErrorEl) gateErrorEl.textContent = "";
      // Шесть цифр введены — подключаемся сами: клавиатура телефона
      // перекрывает кнопку, и дотянуться до неё получается не всегда.
      if (digits.length === 6 && !gateBusy) {
        clearTimeout(gateAutoTimer);
        gateAutoTimer = setTimeout(tryAuth, 220);
      }
    });
    pinInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.keyCode === 13) tryAuth();
    });
    // Держим поле над клавиатурой (важно для iOS Safari).
    pinInput.addEventListener("focus", function () {
      syncGateViewport();
      setTimeout(function () {
        syncGateViewport();
        if (pinInput && pinInput.scrollIntoView) {
          try {
            pinInput.scrollIntoView({ block: "center", behavior: "smooth" });
          } catch (e) {}
        }
      }, 260);
    });
    bindGateViewport();
    syncGateViewport();
    setTimeout(function () {
      if (pinInput) pinInput.focus();
    }, 120);
  }

  function hideGate() {
    clearTimeout(gateAutoTimer);
    gateAutoTimer = null;
    unbindGateViewport();
    gateBusy = false;
    if (gateEl) {
      gateEl.parentNode && gateEl.parentNode.removeChild(gateEl);
      gateEl = null;
      pinInput = null;
      gateErrorEl = null;
      gateStatusEl = null;
    }
  }

  function gateError(msg) {
    gateStatus("");
    if (gateErrorEl) gateErrorEl.textContent = msg || "";
  }

  // Ошибка ввода: поле очищаем и снова фокусируем — иначе после неверного PIN
  // шесть уже введённых цифр блокировали набор новых.
  function resetPinField() {
    if (!pinInput) return;
    pinInput.value = "";
    enteredPin = "";
    try {
      pinInput.focus();
    } catch (e) {}
  }

  // ─── WebSocket ───
  function connect() {
    if (closed) return;
    // Уже есть живое соединение — второе не поднимаем (иначе события
    // приходят дважды, а «Переподключиться» плодит лишние сокеты).
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
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
        setGateBusy(true, "Проверяю PIN…");
        try {
          ws.send(JSON.stringify({ t: "auth", pin: enteredPin }));
        } catch {}
      } else {
        showGate();
        setGateBusy(false);
        gateStatus("Соединение с ПК установлено. Введи PIN.");
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
        setGateBusy(false);
        if (gateEl) {
          resetPinField();
          gateError(m.lock ? "Слишком много попыток. Вход заблокирован на 5 минут." : "Неверный PIN. Попробуй ещё раз.");
        }
      } else if (m.t === "auth_lock") {
        authed = false;
        setGateBusy(false);
        resetPinField();
        gateError("Слишком много неверных попыток. Переподключение…");
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
      setGateBusy(false);
      // Все зависшие вызовы — отклоняем (соединение упало).
      var pend = pending;
      pending = new Map();
      pend.forEach(function (p) {
        p.reject(new Error("Соединение с ПК потеряно"));
      });
      if (wasAuthed) {
        showGate();
        setGateBusy(false);
        gateStatus("Соединение потеряно. Введи PIN заново.");
      } else if (gateEl) {
        gateStatus("Связь с ПК потеряна. Переподключаюсь…");
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