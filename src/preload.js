"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  isElectron: true,
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s) => ipcRenderer.invoke("settings:set", s),
  loadChats: () => ipcRenderer.invoke("chats:load"),
  saveChats: (d) => ipcRenderer.invoke("chats:save", d),
  sendMessage: (messages, opts) => ipcRenderer.invoke("ai:send", messages, opts || {}),
  answerQuestion: (text) => ipcRenderer.invoke("ai:answer", text),
  undoStatus: () => ipcRenderer.invoke("undo:status"),
  undoRollback: () => ipcRenderer.invoke("undo:rollback"),
  stopMessage: () => ipcRenderer.invoke("ai:stop"),
  testConnection: (ui) => ipcRenderer.invoke("ai:test", ui),
  listModels: (ui) => ipcRenderer.invoke("ai:models", ui),
  g4fTest: (opts) => ipcRenderer.invoke("g4f:test", opts),
  g4fProbe: (opts) => ipcRenderer.invoke("g4f:probe", opts),
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDir"),
  onAiEvent: (cb) => {
    ipcRenderer.on("ai:event", (_e, ev) => cb(ev));
  },

  // GitHub OAuth (device flow)
  githubDeviceStart: () => ipcRenderer.invoke("github:deviceStart"),
  githubDeviceCancel: () => ipcRenderer.invoke("github:deviceCancel"),
  githubDisconnect: () => ipcRenderer.invoke("github:disconnect"),
  githubUser: () => ipcRenderer.invoke("github:user"),
  onGithubEvent: (cb) => {
    ipcRenderer.on("github:event", (_e, ev) => cb(ev));
  },
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

  // Файлы (панель проекта)
  fsListTree: (dir) => ipcRenderer.invoke("fs:listTree", dir),
  fsReadFile: (p) => ipcRenderer.invoke("fs:readFile", p),
  fsReadImage: (p) => ipcRenderer.invoke("fs:readImage", p),
  fsCreateFile: (dir, name, content) => ipcRenderer.invoke("fs:createFile", dir, name, content),
  fsCreateFolder: (dir, name) => ipcRenderer.invoke("fs:createFolder", dir, name),
  fsWriteFile: (p, content) => ipcRenderer.invoke("fs:writeFile", p, content),
  fsDelete: (p) => ipcRenderer.invoke("fs:delete", p),
  fsImportDropped: (dir, items) => ipcRenderer.invoke("fs:importDropped", dir, items),
  fsPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return (file && file.path) || "";
    }
  },
  fsOpenInExplorer: (p) => ipcRenderer.invoke("fs:openInExplorer", p),

  // Проекты (панель проекта, до 10)
  projectsList: () => ipcRenderer.invoke("projects:list"),
  projectsCreate: (name, dir) => ipcRenderer.invoke("projects:create", name, dir || ""),
  projectsActivate: (id) => ipcRenderer.invoke("projects:activate", id),
  projectsRemove: (id) => ipcRenderer.invoke("projects:remove", id),

  // Git (панель проекта)
  gitRepoInfo: (dir) => ipcRenderer.invoke("git:repoInfo", dir),
  gitStatus: (dir) => ipcRenderer.invoke("git:status", dir),
  gitLog: (dir, n) => ipcRenderer.invoke("git:log", dir, n),
  gitCommitDetail: (dir, hash) => ipcRenderer.invoke("git:commitDetail", dir, hash),
  gitRevert: (dir, hash) => ipcRenderer.invoke("git:revert", dir, hash),
  gitResetHard: (dir, hash) => ipcRenderer.invoke("git:resetHard", dir, hash),
  gitRestore: (dir) => ipcRenderer.invoke("git:restore", dir),
  gitUndoLastCommit: (dir) => ipcRenderer.invoke("git:undoLastCommit", dir),
  gitClone: (base, url) => ipcRenderer.invoke("git:clone", base, url),
  gitDiff: (dir, file) => ipcRenderer.invoke("git:diff", dir, file),
  gitCommit: (dir, message) => ipcRenderer.invoke("git:commit", dir, message),
  gitPush: (dir) => ipcRenderer.invoke("git:push", dir),

  // GitHub repo picker (opts: { query, page })
  githubPickRepo: (repoSlug) => ipcRenderer.invoke("github:pickRepo", repoSlug),
  githubRepos: (opts) => ipcRenderer.invoke("github:repos", opts || {}),
  githubSelectRepo: (repoSlug, workingDir) => ipcRenderer.invoke("github:selectRepo", repoSlug, workingDir),
  githubSelectedRepo: () => ipcRenderer.invoke("github:selectedRepo"),
  githubUnselectRepo: () => ipcRenderer.invoke("github:unselectRepo"),
  // Создать НОВЫЙ репозиторий и выгрузить в него папку проекта (opts: { dir, name, description, private })
  githubPublish: (opts) => ipcRenderer.invoke("github:publish", opts || {}),

  // Пользовательский терминал (нижняя панель)
  termStart: () => ipcRenderer.invoke("term:start"),
  termInput: (text) => ipcRenderer.invoke("term:input", text),
  termStop: () => ipcRenderer.invoke("term:stop"),
  termStatus: () => ipcRenderer.invoke("term:status"),
  termComplete: (prefix) => ipcRenderer.invoke("term:complete", prefix),
  onTermEvent: (cb) => {
    ipcRenderer.on("term:event", (_e, ev) => cb(ev));
  },

  // Быстрый запуск проекта в превью: старт/стоп dev-сервера + освобождение порта
  devStart: (dir, command) => ipcRenderer.invoke("dev:start", dir, command),
  devStop: () => ipcRenderer.invoke("dev:stop"),
  devStatus: (dir) => ipcRenderer.invoke("dev:status", dir),
  onDevEvent: (cb) => {
    ipcRenderer.on("dev:event", (_e, ev) => cb(ev));
  },

  // Мобильный доступ (LAN + PWA + PIN): статус моста и новый PIN
  mobileStatus: () => ipcRenderer.invoke("mobile:status"),
  mobilePinRegen: () => ipcRenderer.invoke("mobile:pinRegen"),

  // Локальный self-update (OTA): статус, проверка, откат, открыть папку
  otaStatus: () => ipcRenderer.invoke("ota:status"),
  otaCheck: () => ipcRenderer.invoke("ota:check"),
  otaRollback: () => ipcRenderer.invoke("ota:rollback"),
  otaOpenDir: () => ipcRenderer.invoke("ota:openDir"),
  otaReset: (removeSource) => ipcRenderer.invoke("ota:reset", removeSource),
});