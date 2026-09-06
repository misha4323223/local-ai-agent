# AI Developer Agent

Десктоп-приложение (Windows / macOS / Linux) — чат с AI-агентом, который умеет создавать папки и файлы, читать их и работать с git-репозиториями.

- **Локальная модель**: Ollama (`http://localhost:11434` по умолчанию)
- **OpenAI-совместимые API**: DeepSeek, OpenAI (GPT), Groq, OpenRouter или любой совместимый (у каждого свой ключ)
- **Anthropic Claude**: нативный Claude API (`https://api.anthropic.com`) или совместимый прокси
- **История чатов**: сохраняется автоматически на диске
- **Git**: clone, status, commit, push, pull (через системный `git`, поддерживаются приватные репозитории через GitHub-токен)

## Сборка под Windows (Bun)

Для сборки нужны только: **Bun** (или Node.js) и **Git** на ПК. Flutter / Visual Studio не требуются.

```bash
bun install              # установить зависимости (один раз)
bun run dist:win         # собрать exe + ZIP
bun run dist:win:installer  # только установщик (NSIS)
```

Результат в папке `dist/`:
- `dist/AI Developer Agent Setup-x.y.z.exe` — установщик (ставит в Program Files, создаёт ярлык)
- `dist/ai_agent-windows-x.y.z.zip` — переносная версия (распаковал и запускай)

Без Bun можно тем же способом через Node: `npm install && npm run dist:win`.

## Запуск без сборки (для разработки)

```bash
bun install
bun run start
```

## Настройка при первом запуске

1. Запусти приложение.
2. Открой ⚙️ Настройки:
   - **Провайдер**: «🖥️ Ollama» / «🌐 OpenAI-совместимые» / «🤖 Claude».
   - **Ollama**: убедись, что запущена (`ollama serve`) и модель скачана (`ollama pull llama3`). URL `http://localhost:11434` уже по умолчанию.
   - **OpenAI-совместимые**: выбери пресет (DeepSeek / OpenAI (GPT) / Groq / OpenRouter / свой), вставь API-ключ, укажи или подтяни модель (кнопка ↻ / «Проверить подключение»).
   - **Claude**: вставь ключ `sk-ant-...` (URL `https://api.anthropic.com` уже по умолчанию), укажи модель (например, `claude-sonnet-4-5`).
   - У каждого провайдера свой URL, ключ и модель — при переключении они сохраняются.
   - **Рабочая директория**: папка, с которой агент будет работать — туда он кладёт файлы и там выполняет git-операции.
   - **GitHub токен** (опционально): для клонирования приватных репозиториев и пуша. Создаётся в GitHub → Settings → Developer settings → Tokens (classic), scope `repo`.
3. Пиши агенту: «создай файл test.txt», «создай папку src/utils», «сделай git status» и т.д.

## Инструменты агента

- **Файлы**: `createFolder` · `writeFile` · `readFile` · `readFileLines` (чтение по строкам) · `searchFile` (поиск в одном файле) · `searchProject` (grep по всему проекту) · `listFiles` (структура проекта) · `editFile` (точечная правка фрагмента) · `listDirectory`
- **Терминал**: `runCommand` (команды в рабочей директории, вывод с кодом завершения и временем; опасные команды — с подтверждением)
- **Интернет (бесплатно)**: `webSearch` (DuckDuckGo) · `webFetch` (чтение страницы по URL)
- **Git**: `gitClone` · `gitStatus` · `gitCommit` · `gitPush` · `gitPull` · `gitLog` · `gitRevert`
- **Диалог**: `askUser` (вопрос пользователю перед необратимым действием)

> ⚠️ Файловые и git-операции выполняются только в десктоп-приложении. В веб-превью (браузер) доступен чат с любым провайдером: OpenAI-совместимыми API и Claude напрямую, а также с локальной Ollama через публичный туннель (URL вида `https://*.ts.net` или `*.lhr.life`) — для этого на машине с Ollama должны быть заданы переменные `OLLAMA_HOST=0.0.0.0` и `OLLAMA_ORIGINS=*`, а в Настройках в поле Ollama URL указан адрес туннеля. Claude из браузера дополнительно требует заголовок `anthropic-dangerous-direct-browser-access` — он добавляется автоматически.

## Структура проекта

```
src/
  main.js              — главный процесс Electron (окно, IPC, AI, файлы, git)
  preload.js           — безопасный мост между UI и главным процессом
  renderer/
    index.html         — интерфейс (русский)
    styles.css         — тёмная тема
    app.js             — логика чата и настроек (+ веб-режим)
    agent-core.js      — промпт агента, определения инструментов
electron-builder.yml   — конфигурация сборки (NSIS + ZIP)
```
