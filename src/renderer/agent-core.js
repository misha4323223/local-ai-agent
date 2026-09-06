"use strict";
/* Общее ядро агента: системный промпт, определения инструментов, стриппер думающих блоков,
   а также унифицированный транспорт к трём семействам провайдеров:
     - "ollama"    — локальная Ollama (нативный /api/chat, NDJSON-стрим)
     - "openai"    — OpenAI-совместимые API (OpenAI, Groq, OpenRouter, DeepSeek, свой) — /chat/completions
     - "anthropic" — Claude (Anthropic Messages API /v1/messages, SSE-стрим)
   Работает и в Electron main (CommonJS), и в браузере (window.AgentCore). */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.AgentCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  const SYSTEM_PROMPT = `Ты — «Ассистент», AI-разработчик-агент, встроенный в приложение AI Developer Agent. Ты помогаешь пользователю с разработкой: создаёшь папки и файлы, читаешь их, работаешь с git-репозиториями. В начале диалога к твоему системному промпту приложение автоматически добавляет блок «САММАРИ ПРОЕКТА» — краткую визитку рабочей папки (имя проекта, скрипты package.json, структура, начало README). Используй её как отправную точку, не переспрашивай очевидное; детали смотри через listFiles / fileOutline / readFileLines, а актуальность проверяй поиском (searchProject / searchFile).

Правила:
1. ВСЕГДА отвечай ТОЛЬКО на русском языке. Никаких английских слов в ответе, даже если пользователь пишет по-английски.
2. Отвечай коротко и по делу.
3. Если пользователь просит что-то сделать (создать файл или папку, прочитать/изменить файл, выполнить git-операцию, запустить команду) — СРАЗУ вызывай нужный инструмент через механизм вызова инструментов (tool_calls). Не отказывайся, не говори «не могу» и не переспрашивай: явная просьба пользователя уже есть.
4. НЕ выводи JSON-код инструментов в текстовый ответ — никаких {"name": "...", "arguments": {...}} и блоков кода с ними. Вызов инструмента происходит автоматически отдельным механизмом: просто опиши действие словами, приложение само выполнит его и вернёт результат.
5. Не выдумывай результаты — сначала выполни инструмент, потом сообщи реальный результат.
6. Инструменты: создание файла — writeFile (path, content), папок — createFolder (path). Чтение — readFile (path); для больших файлов — readFileLines (path, start, count), поиск по содержимому — searchFile (path, pattern), поиск по всему проекту — searchProject (pattern), обзор структуры проекта — listFiles (path). Точечные правки — editFile (path, oldText, newText), для этого сначала прочитай нужный фрагмент файла. Выполнение команд — runCommand (command). Поиск в интернете — webSearch (query); чтобы прочитать найденную страницу целиком — webFetch (url). Если нужен ответ пользователя перед действием — askUser (question). Не выдумывай других названий инструментов.
6a. Перед изменениями в чужом/большом проекте сначала осмотрись: listFiles (корень), затем searchProject или searchFile — найди, где что лежит, и только потом правь. Это экономит токены и не ломает чужой код.
7. Создание файлов и папок безопасно и разрешено — выполняй без колебаний. ПУШ НА GITHUB ЗАПРЕЩЁН: никогда не выполняй git push (ни инструментом gitPush, ни gitPublish — созданием нового репозитория и публикацией кода, — ни командой через runCommand), пока пользователь ЯВНО не разрешит — включит настройку «Разрешить агенту git push» (Настройки → GitHub) или сам попросит запушить. Если gitPush вернул блокировку — сообщи, как её снять (включить настройку или нажать Push в панели проекта → Изменения), и НЕ пытайся обойти блокировку. Другие опасные действия (удаление данных, очистка истории) — тоже только по явной просьбе. Если программа не установлена или команда не найдена: проверь checkInstalledProgram / canExecute, установи installSystemPackage, обнови PATH через refreshEnv; репозиторий без git можно скачать downloadAndExtract; непонятный код ошибки объяснит explainError; команда с правами администратора — runCommandAsAdmin.
8. Если пользователь просто здоровается — поприветствуй и спроси, чем помочь.
9. Не выводи блоки рассуждений вроде <think>...</think> в ответе — только итоговый текст.
10. Когда задача неоднозначна (куда писать, какой вариант выбрать, делать ли необратимое действие) — сначала спроси пользователя через askUser.

11. Длительные процессы (серверы, базы данных, watcher) запускай через startBackground — он не блокирует выполнение и возвращает id. Проверяй готовность сервера через checkUrl/checkPort, читай логи через backgroundOutput, отправляй ввод через sendInput, останавливай через stopBackground. Для серии команд с сохранением состояния терминала (переменные, текущая папка) используй shellStart/shellSend. Docker — через dockerBuild/dockerRun/dockerExec. Изображения показывай через showImage.
12. Оформляй ответы красиво и наглядно: используй markdown — заголовки, списки (в т.ч. чек-листы вида \`- [ ]\` / \`- [x]\`), таблицы, жирный текст, блоки кода с указанием языка (\`\`\`js, \`\`\`bash, \`\`\`json и т.п.). Для схем и диаграмм выводи блок \`\`\`mermaid с диаграммой одного из поддерживаемых типов: flowchart (направление TD или LR; узлы A[текст], A(текст), A{текст}, A((текст)); стрелки -->, ---, -.->, ==>; подписи вида B -->|да| C) или sequenceDiagram (participant X as Имя, A->>B: сообщение, A-->>B: ответ, Note over A,B: текст). Не рисуй схемы символами ASCII — только через mermaid.
13. Управление окружением: для установки пакетов используй installPackage (определяет менеджер сам), для проверки кода — lintProject (tsc/eslint), для тестов — runTests. Сравнение файлов — diffView (показывает визуальный дифф), встроенный предпросмотр сайта — previewUI, скриншот страницы — screenshotCapture (показывается во встроенном просмотрщике). Переменные окружения задавай через envSet (значения подмешиваются во все команды автоматически), просматривай через envList, удаляй через envUnset.
14. Большие файлы: не читай файл целиком через readFile, если он больше ~800 строк — readFile сам вернёт краткий обзор (число строк, структура, начало и конец). Для больших файлов сначала вызови fileOutline (карта структуры с номерами строк), затем читай нужные участки через readFileLines (диапазон 100–500 строк). Чтобы найти код в большом файле, используй searchFile: context N — строки вокруг совпадения, а blocks: true — показ ЦЕЛИКОМ функции/класса, внутри которых нашлись совпадения (экономит контекст: не надо читать файл ради одного места). Правь большие файлы через editFile в режиме startLine/endLine (замена по номерам строк) — поиск точного текста в 10 000+ строках часто не срабатывает.
15. После завершения любой работы (создание/правка файлов, выполнение команд, git-операции, запуск серверов, поиск в интернете и т.п.) ВСЕГДА пиши финальный итоговый ответ-отчёт, который полноценно отвечает на вопрос пользователя. Отчёт должен быть структурированным и включать: что именно сделано; какие файлы созданы/изменены (пути); какие команды выполнялись и с каким результатом; как проверить результат самому пользователю (что запустить, какой URL открыть, какие порты слушать); известные ограничения или что осталось на усмотрение пользователя. Оформляй отчёт красиво — заголовками и списками, при необходимости таблицей и mermaid-схемой. Не заканчивай ответ фразой «задача выполнена» без отчёта о том, что конкретно сделано.
16. Анализ проекта и рефакторинг: чтобы понять файл без чтения целиком — readFileStructure (импорты/экспорты/объявления верхнего уровня) или fileOutline (функции/классы). Откат своей правки — undoEdit. Переименование идентификатора — refactorRename (сначала dryRun: true). Проверка API — apiRequest. Проверка зависимостей — getDependencies (audit: true для уязвимостей). Форматирование — formatCode. SQL-запросы — dbQuery (нужен psql/mysql в системе). Запуск скриптов из package.json — runScript. Команда с повторными попытками или ожиданием текста в выводе (например «listening») — runCommandOutput. Полная проверка проекта (tsc + eslint + тесты) — validateProject. Ветки git — gitBranch (текущая + список), сравнение веток — gitDiff, отмена последнего коммита без потери изменений — gitUndoLastCommit (soft reset).
17. Запуск проекта: запускай проект ТОЛЬКО через встроенный терминал приложения (инструменты runCommand / startBackground / shellStart) — не проси пользователя запускать проект вручную и не открывай внешние терминалы. Dev-сервер по умолчанию запускай на порту 5000 (http://localhost:5000), если в конфиге проекта явно не задан другой порт (проверь package.json / .env / конфиги). После запуска проверь готовность через проверь через checkUrl/checkPort и сообщи пользователю адрес.
18. Изображения (вспомогательная модель, отдельный ключ): для разбора картинки/скриншота используй analyzeImage (path, question) — вспомогательная vision-модель вернёт подробное текстовое описание. Для создания картинок (баннер для главной, иконка, иллюстрация) используй generateImage (prompt, filename, aspect_ratio) — файл сохранится в рабочую директорию, пользователю покажется превью, а ты встраивай путь в проект (например <img src="...">). Если пользователь прислал скриншот — он уже автоматически разобран vision-моделью и описание подставлено в контекст; можешь дополнительно вызвать analyzeImage для деталей.
checkUrl/checkPort и сообщи пользователю адрес.

Доступные инструменты: createFolder, readFile, readFileLines, writeFile, editFile, searchFile, listDirectory, runCommand, webSearch, webFetch, gitClone, gitStatus, gitCommit, gitPush, gitPublish, gitPull, gitLog, gitRevert, askUser, startBackground, listBackground, backgroundOutput, sendInput, stopBackground, shellStart, shellSend, checkUrl, openUrl, showImage, checkPort, listPorts, dockerBuild, dockerRun, dockerExec, installPackage, lintProject, runTests, diffView, previewUI, screenshotCapture, envSet, envList, envUnset, fileOutline, readFileStructure, explainCode, undoEdit, refactorRename, runCommandOutput, retryCommand, timeoutCommand, checkInstalledProgram, canExecute, installSystemPackage, runCommandAsAdmin, refreshEnv, getSystemInfo, explainError, downloadAndExtract, apiRequest, runScript, validateProject, gitBranch, gitDiff, gitUndoLastCommit, getDependencies, formatCode, dbQuery, gitCheckout, findReferences, analyzeImage, generateImage.`;

  const TOOL_DEFINITIONS = [
    {
      type: "function",
      function: {
        name: "createFolder",
        description: "Создать папку (рекурсивно, вместе с родительскими). path — путь к папке; относительный путь резолвится относительно рабочей директории.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь к создаваемой папке" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "readFile",
        description: "Прочитать содержимое текстового файла. path — путь к файлу (относительный путь — от рабочей директории). Для больших файлов (более ~800 строк) возвращает не всё содержимое, а краткий обзор: число строк, первые строки, структуру файла (fileOutline) и конец файла — чтобы не жечь токены. Читай нужные участки через readFileLines, ищи код через searchFile (с параметром context), структуру смотри через fileOutline.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь к файлу" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "writeFile",
        description: "Записать или перезаписать текстовый файл. Родительские папки создаются автоматически. content — полное содержимое файла.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            content: { type: "string", description: "Содержимое файла" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listDirectory",
        description: "Показать список файлов и папок в директории.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь к директории" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitClone",
        description: "Клонировать git-репозиторий в рабочую директорию (или в указанную папку directory).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL репозитория (https)" },
            directory: { type: "string", description: "Папка назначения (необязательно)" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitStatus",
        description: "Показать статус git-репозитория в рабочей директории.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "gitCommit",
        description: "Сделать git add -A и git commit с указанным сообщением message.",
        parameters: {
          type: "object",
          properties: { message: { type: "string", description: "Сообщение коммита" } },
          required: ["message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitPush",
        description: "Отправить коммиты в удалённый репозиторий (git push).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "gitPublish",
        description: "Создать НОВЫЙ репозиторий на GitHub и выгрузить в него текущую папку проекта (git init, если нужно, первый коммит и push). Требует включённой настройки «Разрешить агенту git push».",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Имя нового репозитория (буквы/цифры/точка/дефис/подчёркивание, без пробелов). По умолчанию — имя текущей папки." },
            description: { type: "string", description: "Краткое описание репозитория (необязательно)." },
            private: { type: "boolean", description: "Приватный репозиторий? По умолчанию true." },
            message: { type: "string", description: "Сообщение первого коммита (по умолчанию Initial commit)." },
            directory: { type: "string", description: "Папка проекта (по умолчанию — рабочая папка агента)." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitPull",
        description: "Забрать изменения из удалённого репозитория (git pull).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "gitLog",
        description: "Показать последние коммиты репозитория (git log --oneline, до 30 штук).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "gitRevert",
        description: "Отменить коммит, создав новый коммит с обратными изменениями (git revert --no-edit). Используй, когда пользователь просит откатить изменения назад.",
        parameters: {
          type: "object",
          properties: { commit: { type: "string", description: "Хэш коммита (например 4f2a1c9) или ссылка вроде HEAD~1" } },
          required: ["commit"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "readFileLines",
        description: "Прочитать только указанные строки файла (для больших файлов, чтобы не выходить из контекста). path — путь; start — номер первой строки (с 1); count — сколько строк прочитать (по умолчанию 100, максимум 500). Чтобы понять, какие строки читать, сначала вызови fileOutline (структура файла) или searchFile.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            start: { type: "integer", description: "Номер первой строки (1-based)" },
            count: { type: "integer", description: "Сколько строк прочитать (по умолчанию 100)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "editFile",
        description: "Точечно заменить фрагмент в существующем файле, не перезаписывая его целиком. Два режима: (1) oldText + newText — точная замена фрагмента (включая отступы); если oldText встречается несколько раз и replaceAll=true — заменяются все вхождения, иначе ошибка с числом вхождений. (2) startLine (+ необязательно endLine) + newText — заменить диапазон строк по номерам, не зная точного текста (надёжно для больших файлов): newText становится строками startLine..endLine вместо старых. Режимы взаимоисключающие: если передан startLine, oldText игнорируется.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            oldText: { type: "string", description: "Точный заменяемый фрагмент (режим 1)" },
            newText: { type: "string", description: "Новый фрагмент / новый текст строк" },
            replaceAll: { type: "boolean", description: "Заменить все вхождения (по умолчанию false)" },
            startLine: { type: "integer", description: "Режим 2: номер первой строки диапазона для замены (1-based)" },
            endLine: { type: "integer", description: "Режим 2: номер последней строки диапазона (по умолчанию = startLine)" },
          },
          required: ["path", "newText"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "runCommand",
        description: "Выполнить команду в терминале внутри рабочей директории приложения (например npm test, npm run build, node script.js, ls, git log). Вывод обрезается до 6000 символов. Команда не должна требовать интерактивного ввода; таймаут 120 секунд. Для длительных серверов и фоновых задач используй startBackground — процесс продолжит работать после завершения вызова. Если команда похожа на dev-сервер (expo start, npm run dev, vite) и не завершилась за таймаут — приложение вернёт подсказку: серверы запускай ТОЛЬКО через startBackground (+ checkUrl/checkPort/stopBackground), а не через runCommand. Для серии команд с сохранением состояния терминала используй shellStart/shellSend.",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "Команда для выполнения в терминале" } },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "webSearch",
        description: "Поиск в интернете (DuckDuckGo, бесплатно, без ключа). Возвращает до 5 результатов: заголовок, URL, сниппет. Используй, когда нужны актуальные сведения, документация, ответы, которых нет в локальных файлах.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Поисковый запрос" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "webFetch",
        description: "Прочитать веб-страницу по URL и вернуть её текст без разметки (до 30000 символов). url — полный адрес страницы, например https://... Используй после webSearch, чтобы прочитать документацию или статью целиком, а не только сниппет.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL страницы для чтения" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "searchFile",
        description: "Поиск по содержимому файла без чтения его целиком (удобно для больших файлов). path — путь к файлу; pattern — строка или регулярное выражение; caseSensitive — true, если важен регистр (по умолчанию поиск без учёта регистра); maxResults — сколько совпадений показать (по умолчанию 40); context — сколько строк ПОКАЗАТЬ ВОКРУГ каждого совпадения (по умолчанию 0), чтобы видеть код, а не только номер строки; blocks — true, чтобы показывать ЦЕЛИКОМ функции/классы/методы, внутри которых нашлись совпадения (с диапазоном строк), вместо отдельных строк. Возвращает номера строк с совпадениями и, при context>0 или blocks=true, сам код вокруг них.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            pattern: { type: "string", description: "Строка или регулярное выражение для поиска" },
            caseSensitive: { type: "boolean", description: "Учитывать регистр (по умолчанию false)" },
            maxResults: { type: "integer", description: "Максимум совпадений в ответе (по умолчанию 40)" },
            context: { type: "integer", description: "Строк контекста вокруг каждого совпадения (по умолчанию 0)" },
            blocks: { type: "boolean", description: "true — показывать целиком функции/классы вокруг совпадений (по умолчанию false)" },
          },
          required: ["path", "pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fileOutline",
        description: "Карта структуры файла: список определений (функции, классы, методы, константы, экспорты, заголовки markdown, CSS-селекторы, HTML-блоки) с номерами строк — как оглавление. path — путь к файлу; pattern — необязательная строка/регулярное выражение для фильтрации определений (по имени или типу). Незаменим для больших файлов (10 000+ строк): сначала fileOutline, потом readFileLines нужного диапазона. Возвращает до 300 определений.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            pattern: { type: "string", description: "Фильтр: показать только определения, чьё имя или тип совпадает (необязательно)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "searchProject",
        description: "Поиск по всем файлам рабочей директории (рекурсивно, как grep по проекту): находит файлы и строки, где встречается pattern (строка или регулярное выражение). Папки node_modules/.git/dist/сборки пропускаются. maxResults — максимум совпадений (по умолчанию 30). Используй, чтобы понять, где в проекте что-то используется, не читая файлы по одному.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Строка или регулярное выражение" },
            path: { type: "string", description: "Подпапка для сужения поиска (необязательно)" },
            caseSensitive: { type: "boolean", description: "Учитывать регистр (по умолчанию false)" },
            maxResults: { type: "integer", description: "Максимум совпадений (по умолчанию 30)" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listFiles",
        description: "Рекурсивно показать структуру файлов и папок рабочей директории (или подпапки path): до 300 записей, глубоко до 6 уровней. Папки node_modules/.git/dist/сборки пропускаются. Используй в начале работы, чтобы осмотреться в незнакомом проекте.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Относительный путь к подпапке (необязательно)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "startBackground",
        description: "Запустить длительный процесс в фоне (сервер, watcher, база данных) и сразу вернуть управление. command — команда (например «npm run dev»); name — короткое имя (необязательно); cwd — рабочая папка (необязательно, по умолчанию рабочая директория). Возвращает id процесса, который используется в listBackground, backgroundOutput, sendInput, stopBackground.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Команда для запуска в фоне" },
            name: { type: "string", description: "Короткое имя процесса (необязательно)" },
            cwd: { type: "string", description: "Рабочая папка процесса (необязательно)" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listBackground",
        description: "Показать запущенные фоновые процессы: id, имя, PID, статус (работает/завершён) и хвост вывода.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "backgroundOutput",
        description: "Показать последние строки вывода фонового процесса по его id. Полезно после запуска сервера, чтобы увидеть логи и убедиться, что он поднялся.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "id фонового процесса" },
            lines: { type: "integer", description: "Сколько последних строк показать (по умолчанию 50)" },
          },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "sendInput",
        description: "Отправить текст в stdin запущенного фонового процесса (например, ответить «y» на подтверждение или ввести команду в интерактивную программу). id — id процесса; input — текст (перевод строки добавляется автоматически).",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "id фонового процесса" },
            input: { type: "string", description: "Текст для отправки в процесс" },
          },
          required: ["id", "input"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "stopBackground",
        description: "Остановить фоновый процесс по его id (убивает сам процесс и его дочерние процессы).",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "id фонового процесса" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "shellStart",
        description: "Запустить постоянную shell-сессию (persistent shell): в отличие от runCommand сессия живёт между вызовами — можно отправлять команды по одной через shellSend и видеть живой вывод. Возвращает id сессии.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Имя сессии (необязательно)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "shellSend",
        description: "Отправить команду в постоянную shell-сессию (id от shellStart) и вернуть её вывод. Состояние терминала (переменные, текущая папка) сохраняется между командами.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "id shell-сессии" },
            command: { type: "string", description: "Команда для выполнения в сессии" },
          },
          required: ["id", "command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkUrl",
        description: "Проверить, что HTTP(S)-сервер отвечает по URL: вернёт статус-код, заголовки и начало тела. Полезно после запуска сервера, чтобы убедиться, что он поднялся.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL для проверки, например http://localhost:3000" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "openUrl",
        description: "Открыть URL в браузере пользователя (внешний браузер по умолчанию). url — полный адрес.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL для открытия" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "showImage",
        description: "Показать пользователю изображение (скриншот, результат сборки фронтенда и т.п.) в просмотрщике приложения. path — путь к файлу изображения (относительный — от рабочей директории).",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь к файлу изображения" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkPort",
        description: "Проверить, занят ли TCP-порт на localhost (слушает ли его какой-то процесс). Полезно узнать, на каком порту поднялся сервер или не упал ли он.",
        parameters: {
          type: "object",
          properties: { port: { type: "integer", description: "Номер порта" } },
          required: ["port"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "listPorts",
        description: "Показать список TCP-портов, которые сейчас слушаются на машине (netstat/ss/lsof). Помогает найти, на каком порту поднялся сервер.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "dockerBuild",
        description: "Собрать Docker-образ из Dockerfile. directory — папка с Dockerfile; tag — имя образа (необязательно). Требует установленного Docker.",
        parameters: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Папка с Dockerfile" },
            tag: { type: "string", description: "Имя образа:tag (необязательно)" },
          },
          required: ["directory"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "dockerRun",
        description: "Запустить Docker-контейнер. image — имя образа; args — дополнительные аргументы (например «-p 5432:5432 -e POSTGRES_PASSWORD=pass»); detached — true, чтобы запустить в фоне и вернуть id контейнера (по умолчанию true). Требует установленного Docker.",
        parameters: {
          type: "object",
          properties: {
            image: { type: "string", description: "Имя Docker-образа" },
            args: { type: "string", description: "Дополнительные аргументы docker run" },
            detached: { type: "boolean", description: "Запустить в фоне (по умолчанию true)" },
          },
          required: ["image"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "dockerExec",
        description: "Выполнить команду внутри запущенного Docker-контейнера (docker exec). container — имя или id контейнера; command — команда для выполнения.",
        parameters: {
          type: "object",
          properties: {
            container: { type: "string", description: "Имя или id контейнера" },
            command: { type: "string", description: "Команда внутри контейнера" },
          },
          required: ["container", "command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "installPackage",
        description: "Установить npm-пакет (или несколько) в проект: определяет пакетный менеджер по lockfile (npm/yarn/pnpm/bun), выполняет установку и возвращает вывод с установленной версией. packageName — имя пакета (можно с версией, например «react@18» или «-D typescript»); dev — true, чтобы установить в devDependencies (по умолчанию false).",
        parameters: {
          type: "object",
          properties: {
            packageName: { type: "string", description: "Имя пакета, например express или react@18.3.1" },
            dev: { type: "boolean", description: "Установить как devDependency (по умолчанию false)" },
          },
          required: ["packageName"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "lintProject",
        description: "Запустить проверку кода проекта (TypeScript tsc --noEmit, если есть tsconfig.json; ESLint, если есть конфиг) и вернуть список ошибок с файлами и строками. Удобнее, чем вручную угадывать команду через runCommand.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "runTests",
        description: "Запустить тесты проекта: выполняет script «test» из package.json (или bun test / npm test по умолчанию) и возвращает вывод с итогом: сколько прошло, сколько упало, какие тесты упали. Для живого прогресса длинных тестов можно запустить через startBackground + backgroundOutput.",
        parameters: {
          type: "object",
          properties: { timeoutMs: { type: "integer", description: "Максимум ожидания в мс (по умолчанию 180000)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "diffView",
        description: "Показать визуальное сравнение двух файлов или двух папок (как в GitHub): возвращает unified-дифф и открывает его в просмотрщике приложения. path1, path2 — пути (относительные — от рабочей директории) или абсолютные.",
        parameters: {
          type: "object",
          properties: {
            path1: { type: "string", description: "Первый файл/папка" },
            path2: { type: "string", description: "Второй файл/папка" },
          },
          required: ["path1", "path2"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "previewUI",
        description: "Открыть веб-интерфейс (собранный сайт, dev-сервер) прямо внутри приложения в нижней панели предпросмотра — не переключаясь во внешний браузер. url — адрес (например http://localhost:3000). В панели пользователь может переключить размер экрана (десктоп/планшет/телефон) и открыть страницу в новой вкладке браузера. Десктопная функция.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL для открытия во встроенном предпросмотре" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "screenshotCapture",
        description: "Сделать скриншот страницы по URL (невидимое окно, ждёт загрузки и отрисовки) и показать его пользователю во встроенном просмотрщике. Незаменимо для проверки вёрстки. url — полный адрес страницы.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL страницы для скриншота" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "envSet",
        description: "Задать переменную окружения для команд агента (runCommand, startBackground, shell, git, docker). Значение сохраняется и автоматически подмешивается в окружение всех последующих команд — не нужно править .env вручную. Например envSet(\"DATABASE_URL\", \"postgres://...\"). Значения не показываются обратно (envList скрывает их).",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Имя переменной, например DATABASE_URL" },
            value: { type: "string", description: "Значение переменной" },
          },
          required: ["key", "value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "envList",
        description: "Показать список заданных переменных окружения агента (только имена и статус — значения скрыты).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "envUnset",
        description: "Удалить переменную окружения агента по имени. key — имя переменной.",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "Имя переменной для удаления" } },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "readFileStructure",
        description: "Показать структуру файла без чтения целиком: импорты/require, экспорты и объявления верхнего уровня с номерами строк. Для больших файлов и быстрого понимания, что откуда берётся. path — путь к файлу, pattern — опциональная регулярка для фильтрации строк.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            pattern: { type: "string", description: "Опциональный фильтр-регулярка (например auth)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",      function: {
        name: "explainCode",
        description: "Показать участок кода с контекстом для объяснения: номера строк, импорты файла, границы enclosing-функции/класса, что определено в окне. Вызывай, когда пользователь просит объяснить код: по результату объясняешь своими словами, не читая файл целиком. path — файл; line — с какой строки начать (без endLine окно само расширится до границ содержащего блока); endLine — явный конец диапазона; symbol — вместо строк найти определение (функцию/класс/метод) по имени и показать его целиком.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            symbol: { type: "string", description: "Имя определения — показать его блок целиком (альтернатива line)" },
            line: { type: "number", description: "Номер строки начала окна (без endLine — расширится до границ блока)" },
            endLine: { type: "number", description: "Конец диапазона строк (необязательно)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
          name: "undoEdit",
          description: "Откатить изменения агента в файле: вернуть содержимое до последней правки (файл, созданный агентом, — удалить). path — путь к файлу (без него — список файлов с числом шагов истории). steps — сколько последних правок откатить за раз (по умолчанию 1, максимум 5).",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Путь к файлу для отката (можно не указывать — вернётся список)" },
              steps: { type: "number", description: "Сколько последних правок откатить (1–5, по умолчанию 1)" },
            },
          },
        },
      },
    {
      type: "function",
      function: {
          name: "refactorRename",
          description: "Переименовать идентификатор (функцию, переменную, класс) во всём проекте или в одном файле. Замена по границам слова, node_modules/.git/dist не трогаются. oldName — старое имя, newName — новое, path — ограничить одним файлом/папкой, dryRun — показать, что изменится, без записи (рекомендуется сначала dryRun).",
          parameters: {
            type: "object",
            properties: {
              oldName: { type: "string", description: "Старое имя (например myFunc)" },
              newName: { type: "string", description: "Новое имя (например myFunction)" },
              path: { type: "string", description: "Ограничить одним файлом или папкой (по умолчанию — весь проект)" },
              dryRun: { type: "boolean", description: "true — только показать изменения, не записывать" },
            },
            required: ["oldName", "newName"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "runCommandOutput",
          description: "Выполнить команду и дождаться её результата с двумя опциями: retries — перезапускать команду, если она упала с ошибкой (до N раз, пауза 2 с); waitFor — ждать, пока в выводе не появится указанный текст (например listening on port 5000), с таймаутом timeoutMs. Команды, похожие на dev-сервер (expo start, npm run dev, vite и т.п.), автоматически запускаются в фоне: инструмент сразу вернёт id фонового процесса (не блокируется и не убивает сервер), а waitFor будет ждать маркер готовности. Управление сервером — через startBackground-инструменты: checkUrl/checkPort (готовность), backgroundOutput(id) (логи), stopBackground(id) (остановка, освобождает порт).",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Команда для выполнения" },
              waitFor: { type: "string", description: "Текст, появления которого ждём в выводе (например listening)" },
              retries: { type: "number", description: "Сколько раз перезапускать при ошибке (по умолчанию 0)" },
              timeoutMs: { type: "number", description: "Таймаут одной попытки в мс (по умолчанию 120000)" },
            },
            required: ["command"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "installSystemPackage",
          description: "Установить СИСТЕМНУЮ программу (git, node, python, ffmpeg и т.п.), а не npm-пакет: на Windows — winget, macOS — brew, Linux — apt/dnf/apk. packageName — короткое имя (git, node, python, ffmpeg) или точный winget-ID вида Vendor.Name (например Git.Git). После установки вызови refreshEnv() (обновит PATH) и checkInstalledProgram() (проверит). Если нужен администратор или установка прервалась — используй runCommandAsAdmin.",
          parameters: {
            type: "object",
            properties: {
              packageName: { type: "string", description: "Имя программы (git) или winget-ID (Git.Git)" },
            },
            required: ["packageName"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "checkInstalledProgram",
          description: "Проверить, установлена ли программа: вернёт установлено/нет, путь к исполняемому файлу и версию (через --version). Ищет в PATH и типовых местах (Program Files и т.п.). Не гадай, установлен ли git/python — сначала проверь этим инструментом.",
          parameters: {
            type: "object",
            properties: {
              programName: { type: "string", description: "Имя программы (например git)" },
            },
            required: ["programName"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "canExecute",
          description: "Быстро проверить, можно ли выполнить команду/программу (есть ли она в PATH). command — команда целиком или имя программы. Для встроенных команд оболочки (cd, echo) тоже скажет «да».",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Команда или имя программы для проверки (например git status или git)" },
            },
            required: ["command"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "refreshEnv",
          description: "Обновить переменную PATH текущей сессии приложения из системного окружения. Вызывай ПОСЛЕ установки программы (installSystemPackage / runCommandAsAdmin), чтобы git/node и т.п. стали видны без перезапуска. Не перезапускает уже открытые терминалы.",
          parameters: { type: "object", properties: {} },
        },
      },
    {
      type: "function",
      function: {
          name: "getSystemInfo",
          description: "Показать информацию о системе: ОС и архитектура, версия Node.js приложения, домашний каталог, рабочая директория, сколько записей в PATH, установлены ли git/node/npm/python/docker. Полезно в начале работы и при диагностике «почему не работает».",
          parameters: { type: "object", properties: {} },
        },
      },
    {
      type: "function",
      function: {
          name: "explainError",
          description: "Объяснить код завершения команды человеческим языком: что он значит (127 — команда не найдена, 126 — нет прав, 740/5 — нужен администратор, 130 — Ctrl+C и т.д.) и что делать дальше. exitCode — код из вывода команды, command — необязательная команда для контекста.",
          parameters: {
            type: "object",
            properties: {
              exitCode: { type: "number", description: "Код завершения (например 127)" },
              command: { type: "string", description: "Команда, которая вернула этот код (необязательно)" },
            },
            required: ["exitCode"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "retryCommand",
          description: "Выполнить команду и перезапускать её до maxRetries раз (с паузой pauseMs), пока она не завершится успешно. Возвращает номер удачной попытки или вывод последней с объяснением explainError. Полезно для нестабильных сборок, сети, конкурентных процессов.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Команда" },
              maxRetries: { type: "number", description: "Сколько повторов при ошибке (по умолчанию 2, максимум 5)" },
              pauseMs: { type: "number", description: "Пауза между попытками в мс (по умолчанию 2000)" },
              timeoutMs: { type: "number", description: "Таймаут одной попытки в мс (по умолчанию 60000)" },
            },
            required: ["command"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "timeoutCommand",
          description: "Выполнить команду с жёстким лимитом времени timeoutMs: если не уложилась — принудительно остановить и вернуть частичный вывод. Полезно против зависших команд и бесконечных ожиданий ввода.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Команда" },
              timeoutMs: { type: "number", description: "Лимит в мс (по умолчанию 15000, минимум 1000)" },
            },
            required: ["command"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "runCommandAsAdmin",
          description: "Выполнить команду с правами администратора: появится системный запрос (UAC на Windows, пароль на macOS/Linux) — пользователь его подтверждает вручную. Нужно для установки программ, когда обычных прав не хватает. Вывод отдельного администрируемого окна не перехватывается; после установки — refreshEnv() и checkInstalledProgram().",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "Команда для запуска с правами администратора" },
            },
            required: ["command"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "downloadAndExtract",
          description: "Скачать архив (.zip / .tar.gz / .tgz) по URL и распаковать в папку (path — по умолчанию downloads в рабочей директории). Позволяет получить репозиторий с GitHub (https://github.com/owner/repo/archive/refs/heads/main.zip) даже если git не установлен. Поддерживает большие архивы (до 300 МБ).",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Прямой URL архива" },
              path: { type: "string", description: "Куда распаковать (по умолчанию <рабочая папка>/downloads)" },
            },
            required: ["url"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "apiRequest",
          description: "Отправить HTTP-запрос: method (GET/POST/PUT/PATCH/DELETE...), url, body (строка или объект), headers (объект). Возвращает статус, заголовки и тело ответа (обрезанное). Заменитель curl/Insomnia для проверки API.",
          parameters: {
            type: "object",
            properties: {
              method: { type: "string", description: "HTTP-метод (по умолчанию GET)" },
              url: { type: "string", description: "Полный URL (например https://api.example.com/v1/items)" },
              body: { type: "string", description: "Тело запроса — строка или JSON-объект" },
              headers: { type: "object", description: "Заголовки (например Authorization: Bearer ...)" },
            },
            required: ["url"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "runScript",
          description: "Запустить скрипт из package.json по имени (например dev, build, start) менеджером проекта. scriptName — имя скрипта, args — опциональные аргументы строкой.",
          parameters: {
            type: "object",
            properties: {
              scriptName: { type: "string", description: "Имя скрипта из package.json (например dev)" },
              args: { type: "string", description: "Дополнительные аргументы (например --port 3000)" },
            },
            required: ["scriptName"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "validateProject",
          description: "Проверить проект одним вызовом: TypeScript (tsc --noEmit, если есть tsconfig), ESLint (если есть конфиг) и тесты (если есть test-скрипт). Возвращает сводный отчёт по каждому этапу.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    {
      type: "function",
      function: {
          name: "gitBranch",
          description: "Показать текущую ветку и список всех веток (локальных и удалённых) репозитория рабочей директории.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    {
      type: "function",
      function: {
          name: "gitDiff",
          description: "Сравнить две ветки (branch1, branch2) или ветку с рабочим деревом (если указана одна). Возвращает список изменённых файлов и статистику; для полного диффа файла используй diffView.",
          parameters: {
            type: "object",
            properties: {
              branch1: { type: "string", description: "Первая ветка (например main); можно не указывать — возьмётся текущая" },
              branch2: { type: "string", description: "Вторая ветка (например feature/x)" },
            },
          },
        },
      },
    {
      type: "function",
      function: {
          name: "gitUndoLastCommit",
          description: "Отменить последний коммит БЕЗ потери изменений — git reset --soft HEAD~1: коммит исчезает, а его изменения остаются в рабочем дереве (можно поправить и закоммитить заново). Используй только если уверен, что это нужно.",
          parameters: {
            type: "object",
            properties: {},
          },
        },
      },
    {
      type: "function",
      function: {
          name: "gitCheckout",
          description: "Переключиться на другую ветку git в рабочем репозитории. branch — имя ветки. create: true — создать новую ветку и переключиться на неё (git checkout -b).",
          parameters: {
            type: "object",
            properties: {
              branch: { type: "string", description: "Имя ветки (например feature/auth)" },
              create: { type: "boolean", description: "true — создать ветку, если её ещё нет" },
            },
            required: ["branch"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "findReferences",
          description: "Найти все использования символа (функции/переменной/класса) по границам слова — как «Найти все ссылки» в IDE, без ложных совпадений внутри других слов. symbol — имя; path — ограничить одним файлом или папкой (без path — весь проект). Каждое вхождение классифицируется: определение / импорт / вызов / ссылка.",
          parameters: {
            type: "object",
            properties: {
              symbol: { type: "string", description: "Имя символа, например createLead" },
              path: { type: "string", description: "Файл или папка для ограничения поиска (по умолчанию — весь проект)" },
            },
            required: ["symbol"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "getDependencies",
          description: "Показать зависимости проекта: dependencies и devDependencies из package.json с установленными версиями. audit: true — дополнительно проверить уязвимости (npm audit, может занять время).",
          parameters: {
            type: "object",
            properties: { audit: { type: "boolean", description: "Запустить npm audit для проверки уязвимостей" } },
          },
        },
      },
    {
      type: "function",
      function: {
          name: "formatCode",
          description: "Отформатировать файл через Prettier (если он установлен в проекте). path — файл или папка; check: true — только проверить форматирование без записи. Если Prettier не установлен — вернёт инструкцию.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Файл или папка для форматирования" },
              check: { type: "boolean", description: "true — только проверить, без записи" },
            },
            required: ["path"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "dbQuery",
          description: "Выполнить SQL-запрос к базе через системный клиент: postgres://... — psql, mysql://... — mysql. Требует установленный CLI-клиент. connectionString — строка подключения, sql — запрос. Возвращает вывод клиента.",
          parameters: {
            type: "object",
            properties: {
              connectionString: { type: "string", description: "Строка подключения (postgres://user:pass@host/db или mysql://...)" },
              sql: { type: "string", description: "SQL-запрос (SELECT/INSERT/UPDATE и т.п.)" },
            },
            required: ["connectionString", "sql"],
          },
        },
      },
    {
      type: "function",
      function: {
          name: "askUser",
        description: "Задать вопрос пользователю и дождаться ответа. Используй, когда нужно уточнить намерение перед необратимым действием, выбрать вариант или получить разрешение. question — текст вопроса. Пользователь увидит вопрос и введёт ответ текстом.",
        parameters: {
          type: "object",
          properties: { question: { type: "string", description: "Текст вопроса пользователю" } },
          required: ["question"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "analyzeImage",
        description: "Проанализировать изображение вспомогательной vision-моделью (второй ключ): вернуть подробное текстовое описание — объекты, текст, UI, цвета, расположение. Используй, когда нужно понять скриншот/картинку/макет, а твоя модель не видит изображения, или для детального разбора. path — путь к файлу изображения; question — (необязательно) что именно нужно описать.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу изображения (.png/.jpg/.jpeg/.webp/.gif/.bmp/.ico)" },
            question: { type: "string", description: "Что именно описать (по умолчанию — полное описание картинки)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "generateImage",
        description: "Сгенерировать изображение по текстовому описанию (вспомогательная модель, второй ключ). Файл сохраняется в рабочую директорию проекта, пользователю показывается превью, возвращается путь — встраивай его в проект (например <img src=\"...\">). prompt — детальное описание картинки; filename — (необязательно) имя файла (по умолчанию generated-<время>.png, расширение добавится само); aspect_ratio — (необязательно) пропорции, например 16:9, 1:1, 9:16, 4:3.",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Подробное описание изображения на английском (модели генерации лучше понимают английские промпты)" },
            filename: { type: "string", description: "Имя файла, например hero.png (по умолчанию generated-<время>.png)" },
            aspect_ratio: { type: "string", description: "Пропорции: 1:1, 16:9, 9:16, 4:3, 3:4 и т.п." },
          },
          required: ["prompt"],
        },
      },
    },
  ];

  // ── Контекст-окно: грубая оценка токенов и обрезка истории ──
  // Русский текст ~ 3–4 символа на токен, код/англ ~ 4; берём 3.6 с запасом.
  function estimateTokens(text) {
    if (Array.isArray(text)) {
      let n = 0;
      for (const p of text) {
        if (!p) continue;
        if (p.type === "text") n += Math.ceil(String(p.text || "").length / 3.6);
        else if (p.type === "image_url") n += 800; // изображение ~ 800 токенов
        else n += 120;
      }
      return Math.ceil(n);
    }
    const s = String(text || "");
    if (!s) return 0;
    return Math.ceil(s.length / 3.6);
  }

  function estimateMessageTokens(m) {
    if (!m) return 0;
    let n = estimateTokens(m.content);
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        n += estimateTokens((tc.function && tc.function.name) || "");
        n += estimateTokens((tc.function && tc.function.arguments) || "");
      }
    }
    return n;
  }

  // Бюджет контекста (токенов) для истории, без учёта system и результата текущего запроса.
  // Локальные модели (qwen3:4b и др.) имеют 8–32k — даём запас на вывод и tool-результаты.
  function contextBudget(provider, model) {
    if (provider === "ollama") return 14000;
    const m = String(model || "");
    if (/deepseek|qwen/i.test(m)) return 26000;
    if (provider === "anthropic") return 80000;
    return 50000;
  }

  // Обрезает массив канонических сообщений так, чтобы их суммарная оценка токенов
  // не превышала budget, сохраняя самые свежие сообщения (диалог идёт от старых к новым).
  // Гарантирует: никогда не выкидываем последнее user-сообщение и не разрываем
  // tool-цепочки в хвосте (assistant tool_calls + его результаты остаются целиком).
  function trimConversation(messages, budget) {
    if (!Array.isArray(messages) || !messages.length) return messages || [];
    const limit = Math.max(1500, budget || contextBudget("openai"));
    let total = 0;
    let cutFrom = 0;
    for (let i = 0; i < messages.length; i++) {
      total += estimateMessageTokens(messages[i]);
      if (total > limit) {
        cutFrom = i;
        break;
      }
    }
    if (cutFrom === 0) return messages;
    // Хвост не трогаем: срез не заходит за последнее user-сообщение, чтобы текущий
    // виток диалога (включая результаты инструментов) остался целым.
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    let start = cutFrom;
    if (lastUser >= 0 && start < lastUser) start = lastUser;
    let kept = messages.slice(start);
    // Не оставляем «висящий» assistant/token в начале среза без его вопроса
    while (kept.length > 1 && kept[0] && kept[0].role !== "user") kept = kept.slice(1);
    if (!kept.length) kept = messages.slice(-2);
    return kept;
  }

  function truncateText(text, max) {
    const s = String(text || "");
    const cap = max || 6000;
    if (s.length <= cap) return s;
    return s.slice(0, cap) + "\n… (обрезано: " + s.length + " символов)";
  }

  // ═══════════════════ Веб: поиск и чтение страниц (без API-ключей) ═══════════════════
  // Общие для Electron main, веб-режима и preview-сервера (server.js).

  function stripHtml(s) {
    return String(s || "")
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
      .trim();
  }

  // Скачивает HTML-страницу с таймаутом; { ok, text } или { ok:false, error }.
  async function downloadHtml(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AI-Developer-Agent/1.0",
          "Accept-Language": "ru,en;q=0.8",
        },
      });
      if (!res.ok) return { ok: false, error: "HTTP " + res.status };
      const text = await res.text();
      return { ok: true, text: text.slice(0, 2 * 1024 * 1024) }; // максимум 2 МБ на обработку
    } catch (e) {
      return { ok: false, error: e && e.name === "AbortError" ? "таймаут" : (e && e.message) || String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  // Распаковывает ссылку DuckDuckGo: //duckduckgo.com/l/?uddg=<url>&rut=... → https://<url>
  function ddgUrlToHttps(url) {
    let u = String(url || "");
    const ud = u.match(/[?&]uddg=([^&]+)/);
    if (ud) {
      try { u = decodeURIComponent(ud[1]); } catch { u = ud[1]; }
    } else if (u.startsWith("//")) {
      u = "https:" + u;
    }
    return u;
  }

  // Парсит html.duckduckgo.com/html: a.result__a + a.result__snippet
  function parseDdgHtml(html) {
    const results = [];
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 5) {
      const url = ddgUrlToHttps(m[1]);
      if (!/^https?:\/\//i.test(url)) continue;
      const title = stripHtml(m[2]);
      if (!title) continue;
      results.push({ title, url });
    }
    const snRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let sn;
    let i = 0;
    while ((sn = snRe.exec(html)) && i < results.length) {
      results[i].snippet = stripHtml(sn[1]);
      i++;
    }
    return results;
  }

  // Парсит lite.duckduckgo.com/lite: a.result-link + td.result-snippet
  function parseDdgLite(html) {
    const results = [];
    const re = /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 5) {
      const url = ddgUrlToHttps(m[1]);
      if (!/^https?:\/\//i.test(url)) continue;
      const title = stripHtml(m[2]);
      if (!title) continue;
      results.push({ title, url });
    }
    const snRe = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
    let sn;
    let i = 0;
    while ((sn = snRe.exec(html)) && i < results.length) {
      results[i].snippet = stripHtml(sn[1]);
      i++;
    }
    return results;
  }

  // Бесплатный веб-поиск: DuckDuckGo без API-ключа. Пробуем html-версию,
  // при пустом ответе (капча/изменение разметки) — lite-версию.
  async function webSearchDDG(query) {
    const q = encodeURIComponent(String(query || "").trim());
    if (!q) return "Ошибка: пустой поисковый запрос";
    let note = "";
    let results = [];
    const htmlRes = await downloadHtml("https://html.duckduckgo.com/html/?q=" + q);
    if (htmlRes.ok) {
      results = parseDdgHtml(htmlRes.text);
    } else {
      note = htmlRes.error || "";
    }
    if (!results.length) {
      const liteRes = await downloadHtml("https://lite.duckduckgo.com/lite/?q=" + q);
      if (liteRes.ok) results = parseDdgLite(liteRes.text);
      else if (!note) note = liteRes.error || "";
    }
    if (!results.length) {
      return "Поиск не дал результатов по запросу: " + query + (note ? " (" + note + ")" : "") + ". Попробуй переформулировать запрос или используй webFetch по известному адресу.";
    }
    return (
      "Результаты поиска по «" + query + "»:\n\n" +
      results
        .map((r, idx) => (idx + 1) + ". " + (r.title || "—") + "\n   " + r.url + (r.snippet ? "\n   " + r.snippet.slice(0, 300) : ""))
        .join("\n\n") +
      "\n\nЧтобы прочитать страницу целиком, используй инструмент webFetch с её URL."
    );
  }

  // Превращает HTML в читаемый текст (убирает скрипты, стили, разметку).
  function htmlToText(html) {
    let s = String(html || "");
    s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
    s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
    s = s.replace(/<svg[\s\S]*?<\/svg>/gi, " ");
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    s = s.replace(/<(br|p|div|li|h[1-6]|tr|section|article|pre|blockquote|table)[^>]*>/gi, "\n");
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    s = s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&mdash;|&ndash;/g, "—").replace(/&hellip;/g, "…");
    s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return s;
  }

  // Читает веб-страницу по URL и возвращает её текст (для чтения документации целиком).
  async function webFetchPage(url) {
    const u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) return "Ошибка: укажи URL вида https://...";
    const res = await downloadHtml(u);
    if (!res.ok) return "Ошибка загрузки страницы: " + res.error;
    let text = htmlToText(res.text);
    if (text.length > 30000) {
      text = text.slice(0, 30000) + "\n… (страница длиннее — показаны первые 30000 символов)";
    }
    if (!text.trim()) {
      return "Страница загружена, но текст не извлёкся (возможно, это JS-приложение или страница-заглушка).";
    }
    return "Содержимое " + u + ":\n\n" + text;
  }

  /* Стриппер думающих блоков <think>...</think> / <thought>...</thought>.
     Устойчив к стримингу: теги могут приходить по кусочкам.
     opts.onHidden(chunk) — если передан, получает текст рассуждений по мере
     стриминга (его можно показать пользователю, как в Replit/Claude). */
  function createThinkingStripper(opts) {
    const onHidden = opts && typeof opts.onHidden === "function" ? opts.onHidden : null;
    let visible = "";
    let hidden = "";
    let inBlock = false;
    const hold = 16; // хвост, в котором может прятаться незавершённый тег
    const openRe = /<think(ing)?>/i;
    const closeRe = /<\/think(ing)?>/i;
    function flushHidden() {
      if (!onHidden || !inBlock) return;
      if (hidden.length > hold) {
        const out = hidden.slice(0, hidden.length - hold);
        hidden = hidden.slice(hidden.length - hold);
        if (out) onHidden(out);
      }
    }
    return {
      push(text) {
        if (!text) return "";
        for (const ch of text) {
          if (!inBlock) {
            visible += ch;
            const m = visible.slice(-hold).match(openRe);
            if (m) {
              visible = visible.slice(0, visible.length - m[0].length);
              hidden = "";
              inBlock = true;
            }
          } else {
            hidden += ch;
            flushHidden();
            const close = hidden.slice(-hold).match(closeRe);
            if (close) {
              // Дофлашиваем рассуждения, не включая сам закрывающий тег
              const idx = hidden.lastIndexOf(close[0]);
              if (idx > 0 && onHidden) onHidden(hidden.slice(0, idx));
              hidden = "";
              inBlock = false;
            }
          }
        }
        let out = "";
        if (!inBlock && visible.length > hold) {
          out = visible.slice(0, visible.length - hold);
          visible = visible.slice(visible.length - hold);
        }
        return out;
      },
      finish() {
        if (inBlock) {
          // Поток оборвался внутри блока — отдаём накопленные рассуждения целиком
          if (onHidden && hidden) onHidden(hidden);
          inBlock = false;
          hidden = "";
          visible = "";
          return "";
        }
        const out = visible;
        visible = "";
        return out;
      },
    };
  }

  function stripThinking(text) {
    const s = createThinkingStripper();
    return s.push(text) + s.finish();
  }

  const TOOL_ALIASES = {
    createfile: "writeFile",
    create_file: "writeFile",
    write_file: "writeFile",
    read_file: "readFile",
    list_directory: "listDirectory",
    mkdir: "createFolder",
    makedirectory: "createFolder",
    make_dir: "createFolder",
    create_folder: "createFolder",
    git_clone: "gitClone",
    git_status: "gitStatus",
    git_commit: "gitCommit",
    git_push: "gitPush",
    git_pull: "gitPull",
    git_log: "gitLog",
    git_revert: "gitRevert",
    read_file_lines: "readFileLines",
    readfilelines: "readFileLines",
    edit_file: "editFile",
    editfile: "editFile",
    run_command: "runCommand",
    runcommand: "runCommand",
    terminal: "runCommand",
    shell: "runCommand",
    execute: "runCommand",
    web_search: "webSearch",
    websearch: "webSearch",
    search: "webSearch",
    internet_search: "webSearch",
    web_fetch: "webFetch",
    webfetch: "webFetch",
    fetch_url: "webFetch",
    fetch: "webFetch",
    open_url: "webFetch",
    read_url: "webFetch",
    readweb: "webFetch",
    search_file: "searchFile",
    searchfile: "searchFile",
    grep: "searchFile",
    find_in_file: "searchFile",
    search_project: "searchProject",
    searchproject: "searchProject",
    file_outline: "fileOutline",
    fileoutline: "fileOutline",
    outline: "fileOutline",
    structure: "fileOutline",
    symbols: "fileOutline",
    toc: "fileOutline",
    file_map: "fileOutline",
    grep_project: "searchProject",
    find: "searchProject",
    rg: "searchProject",
    list_files: "listFiles",
    listfiles: "listFiles",
    tree: "listFiles",
    ls: "listFiles",
    project_tree: "listFiles",
    ask_user: "askUser",
    askuser: "askUser",
    question: "askUser",
    ask: "askUser",
    start_background: "startBackground",
    startbackground: "startBackground",
    bg: "startBackground",
    run_background: "startBackground",
    list_background: "listBackground",
    listbackground: "listBackground",
    background_output: "backgroundOutput",
    backgroundoutput: "backgroundOutput",
    process_output: "backgroundOutput",
    logs: "backgroundOutput",
    send_input: "sendInput",
    sendinput: "sendInput",
    sendkeys: "sendInput",
    simulate_input: "sendInput",
    stop_background: "stopBackground",
    stopbackground: "stopBackground",
    kill_process: "stopBackground",
    shell_start: "shellStart",
    shellstart: "shellStart",
    start_shell: "shellStart",
    shell_send: "shellSend",
    shellsend: "shellSend",
    shell_command: "shellSend",
    check_url: "checkUrl",
    checkurl: "checkUrl",
    ping_url: "checkUrl",
    openurl: "openUrl",
    open_url_browser: "openUrl",
    show_image: "showImage",
    showimage: "showImage",
    display_image: "showImage",
    check_port: "checkPort",
    checkport: "checkPort",
    list_ports: "listPorts",
    listports: "listPorts",
    netstat: "listPorts",
    docker_build: "dockerBuild",
    dockerbuild: "dockerBuild",
    docker_run: "dockerRun",
    dockerrun: "dockerRun",
    docker_exec: "dockerExec",
    dockerexec: "dockerExec",
    install_package: "installPackage",
    installpackage: "installPackage",
    npm_install: "installPackage",
    yarn_add: "installPackage",
    pnpm_add: "installPackage",
    lint_project: "lintProject",
    lintproject: "lintProject",
    lint: "lintProject",
    tsc_check: "lintProject",
    eslint: "lintProject",
    run_tests: "runTests",
    runtests: "runTests",
    test: "runTests",
    runtest: "runTests",
    diff_view: "diffView",
    diffview: "diffView",
    compare: "diffView",
    preview_ui: "previewUI",
    previewui: "previewUI",
    preview: "previewUI",
    open_preview: "previewUI",
    screenshot_capture: "screenshotCapture",
    screenshotcapture: "screenshotCapture",
    screenshot: "screenshotCapture",
    capture: "screenshotCapture",
    env_set: "envSet",
    envset: "envSet",
    set_env: "envSet",
    export_env: "envSet",
    env_list: "envList",
    envlist: "envList",
    list_env: "envList",
    env_unset: "envUnset",
    envunset: "envUnset",
    unset_env: "envUnset",
    read_file_structure: "readFileStructure",
    readfilestructure: "readFileStructure",
    file_structure: "readFileStructure",
    imports_exports: "readFileStructure",
    explain_code: "explainCode",
    explaincode: "explainCode",
    explain: "explainCode",
    explain_file: "explainCode",
    edit_file_nth: "editFile",
    editfilenth: "editFile",
    get_functions: "fileOutline",
    getfunctions: "fileOutline",
    functions: "fileOutline",
    exports: "fileOutline",
    undo_edit: "undoEdit",
    undoedit: "undoEdit",
    undo: "undoEdit",
    rollback: "undoEdit",
    refactor_rename: "refactorRename",
    refactorrename: "refactorRename",
    rename_symbol: "refactorRename",
    rename_function: "refactorRename",
    rename: "refactorRename",
    run_command_output: "runCommandOutput",
    runcommandoutput: "runCommandOutput",
    run_with_retry: "runCommandOutput",
    wait_for: "runCommandOutput",
    run_until: "runCommandOutput",
    api_request: "apiRequest",
    apirequest: "apiRequest",
    http_request: "apiRequest",
    http: "apiRequest",
    request: "apiRequest",
    curl: "apiRequest",
    run_script: "runScript",
    runscript: "runScript",
    npm_run: "runScript",
    run_npm_script: "runScript",
    validate_project: "validateProject",
    validateproject: "validateProject",
    validate: "validateProject",
    check_project: "validateProject",
    full_check: "validateProject",
    git_branch: "gitBranch",
    gitbranch: "gitBranch",
    branch: "gitBranch",
    branches: "gitBranch",
    git_checkout: "gitCheckout",
    gitcheckout: "gitCheckout",
    checkout: "gitCheckout",
    switch_branch: "gitCheckout",
    switchbranch: "gitCheckout",
    git_diff_branches: "gitDiff",
    gitdiff: "gitDiff",
    compare_branches: "gitDiff",
    branch_diff: "gitDiff",
    git_undo_last_commit: "gitUndoLastCommit",
    gitundolastcommit: "gitUndoLastCommit",
    undo_commit: "gitUndoLastCommit",
    soft_reset: "gitUndoLastCommit",
    find_references: "findReferences",
    findreferences: "findReferences",
    references: "findReferences",
    where_used: "findReferences",
    usages: "findReferences",
    symbol_usage: "findReferences",
    reset_soft: "gitUndoLastCommit",
    get_dependencies: "getDependencies",
    getdependencies: "getDependencies",
    dependencies: "getDependencies",
    deps: "getDependencies",
    npm_ls: "getDependencies",
    npm_audit: "getDependencies",
    format_code: "formatCode",
    formatcode: "formatCode",
    format: "formatCode",
    prettier: "formatCode",
    db_query: "dbQuery",
    dbquery: "dbQuery",
    sql: "dbQuery",
    psql: "dbQuery",
    query_db: "dbQuery",
    install_system_package: "installSystemPackage",
    installsystempackage: "installSystemPackage",
    install_system: "installSystemPackage",
    check_installed_program: "checkInstalledProgram",
    checkinstalledprogram: "checkInstalledProgram",
    check_program: "checkInstalledProgram",
    installed: "checkInstalledProgram",
    can_execute: "canExecute",
    canexecute: "canExecute",
    exists: "canExecute",
    refresh_env: "refreshEnv",
    refreshenv: "refreshEnv",
    refresh_path: "refreshEnv",
    get_system_info: "getSystemInfo",
    getsysteminfo: "getSystemInfo",
    system_info: "getSystemInfo",
    os_info: "getSystemInfo",
    explain_error: "explainError",
    explainerror: "explainError",
    exit_code: "explainError",
    retry_command: "retryCommand",
    retrycommand: "retryCommand",
    timeout_command: "timeoutCommand",
    timeoutcommand: "timeoutCommand",
    run_as_admin: "runCommandAsAdmin",
    runcommandasadmin: "runCommandAsAdmin",
    admin: "runCommandAsAdmin",
    elevate: "runCommandAsAdmin",
    download_and_extract: "downloadAndExtract",
    downloadandextract: "downloadAndExtract",
    download_zip: "downloadAndExtract",
    extract_archive: "downloadAndExtract",
  };
  const KNOWN_TOOLS = TOOL_DEFINITIONS.map((t) => t.function.name);

  function normalizeToolName(name) {
    const n = String(name || "").trim();
    if (!n) return "";
    if (KNOWN_TOOLS.includes(n)) return n;
    return TOOL_ALIASES[n.toLowerCase()] || n;
  }

  function normalizeToolArgs(args) {
    if (args && typeof args === "object") return args;
    if (typeof args === "string") {
      try {
        return JSON.parse(args);
      } catch {
        return { raw: args };
      }
    }
    return {};
  }

  // Запасной способ вызова инструментов: если модель вместо tool_calls
  // напечатала JSON-объект вида {"name": "...", "arguments": {...}} текстом,
  // приложение само найдёт его и выполнит.
  function extractToolCallsFromText(text) {
    const calls = [];
    if (!text) return calls;
    let i = 0;
    while (i < text.length) {
      const start = text.indexOf("{", i);
      if (start === -1) break;
      let depth = 0;
      let inStr = false;
      let esc = false;
      let end = -1;
      for (let k = start; k < text.length; k++) {
        const ch = text[k];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            end = k + 1;
            break;
          }
        }
      }
      if (end === -1) break;
      const raw = text.slice(start, end);
      i = end;
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      // Поддерживаем разные форматы, которые модели печатают текстом:
      // 1) {"name": "writeFile", "arguments": {...}}
      // 2) {"function": {"name": "writeFile", "arguments": {...}}}  (формат Ollama)
      // 3) {"tool": "gitStatus", "parameters": {...}}
      let name = obj.name || (obj.function && obj.function.name) || obj.tool;
      let args = obj.arguments != null ? obj.arguments : obj.function && obj.function.arguments != null ? obj.function.arguments : obj.parameters;
      if (typeof name !== "string") continue;
      name = normalizeToolName(name);
      if (!KNOWN_TOOLS.includes(name)) continue;
      calls.push({ name, args: normalizeToolArgs(args), raw });
    }
    return calls;
  }

  // ═══════════════════ Унифицированный транспорт провайдеров ═══════════════════
  // Канонический формат сообщений внутри цикла агента — «OpenAI-стиль»:
  //   { role: "system"|"user"|"assistant", content }
  //   assistant с вызовами инструментов: { role:"assistant", content, tool_calls:[{ id, type:"function",
  //     function:{ name, arguments: "<json-строка>" } }] }
  //   результат инструмента:            { role:"tool", tool_call_id, content }
  // Для каждого провайдера сообщения конвертируются на лету при отправке запроса.

  const DEFAULT_BASES = {
    ollama: "http://localhost:11434",
    openai: "https://api.groq.com/openai/v1",
    anthropic: "https://api.anthropic.com",
  };

  function trimBase(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  // Anthropic Messages API живёт под /v1; если пользователь вписал URL уже с /v1 — не дублируем.
  function anthropicApiBase(url) {
    return trimBase(url).replace(/\/v1\/?$/i, "");
  }

  function baseFor(provider, s) {
    if (provider === "ollama") return trimBase(s.ollamaUrl || DEFAULT_BASES.ollama);
    if (provider === "anthropic") return anthropicApiBase(s.anthropicUrl || DEFAULT_BASES.anthropic);
    return trimBase(s.openaiUrl || s.externalUrl || DEFAULT_BASES.openai); // legacy externalUrl — миграция
  }

  function apiKeyFor(provider, s) {
    if (provider === "anthropic") return s.anthropicApiKey || s.apiKey || "";
    if (provider === "openai") return s.openaiApiKey || s.apiKey || "";
    return "";
  }

  function apiHeaders(provider, apiKey, fromBrowser) {
    const h = { "Content-Type": "application/json" };
    if (provider === "ollama") return h;
    if (provider === "anthropic") {
      h["x-api-key"] = apiKey || "";
      h["anthropic-version"] = "2023-06-01";
      // Anthropic разрешает вызовы из браузера только с этим заголовком.
      if (fromBrowser) h["anthropic-dangerous-direct-browser-access"] = "true";
      return h;
    }
    if (apiKey) h.Authorization = "Bearer " + apiKey;
    return h;
  }

  function jsonArgs(args) {
    if (args && typeof args === "object") return args;
    if (typeof args === "string") {
      try {
        return JSON.parse(args);
      } catch {
        return { raw: args };
      }
    }
    return {};
  }

  function genCallId() {
    return "call_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  // ── Канонический content сообщения: строка ИЛИ массив частей
  // [{ type: "text", text }, { type: "image_url", image_url: { url: "data:image/png;base64,..." } }]
  function partsText(parts) {
    return (parts || []).filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
  }
  function partsImages(parts) {
    return (parts || []).filter((p) => p && p.type === "image_url" && p.image_url && p.image_url.url);
  }
  function contentForProvider(provider, content) {
    if (!Array.isArray(content)) return content == null ? "" : content;
    const text = partsText(content);
    const imgs = partsImages(content);
    if (provider === "ollama") {
      // Ollama: content — строка, изображения — массив base64 (без префикса data:)
      const images = imgs.map((p) => {
        const url = String(p.image_url.url || "");
        const idx = url.indexOf(";base64,");
        return idx >= 0 ? url.slice(idx + 8) : url;
      });
      return { content: text, images };
    }
    if (provider === "anthropic") {
      // Claude: content — массив блоков { type: "image", source: { type: "base64", media_type, data } }
      const blocks = [];
      if (text) blocks.push({ type: "text", text });
      for (const p of imgs) {
        const url = String(p.image_url.url || "");
        const m = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
        if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      }
      return blocks;
    }
    return content; // OpenAI-совместимые: массив частей с image_url как есть
  }

  // ── Конвертация канонических сообщений в диалект провайдера ──
  function messagesForProvider(provider, messages) {
    if (provider === "ollama") {
      // Ollama: tool_calls без id и type; arguments — объект (не строка); content — строка.
      return messages.map((m) => {
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          return {
            role: "assistant",
            content: m.content || "",
            tool_calls: m.tool_calls.map((tc) => ({
              function: {
                name: (tc.function && tc.function.name) || "",
                arguments: jsonArgs(tc.function && tc.function.arguments),
              },
            })),
          };
        }
        if (Array.isArray(m.content)) {
          const c = contentForProvider("ollama", m.content);
          const msg = { role: m.role, content: c.content };
          if (c.images && c.images.length) msg.images = c.images;
          return msg;
        }
        return { role: m.role, content: m.content == null ? "" : m.content };
      });
    }
    if (provider === "anthropic") {
      const out = [];
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === "system") continue; // уходит в верхнеуровневое поле system
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const blocks = [];
          if (m.content) blocks.push({ type: "text", text: m.content });
          const ids = [];
          for (const tc of m.tool_calls) {
            const id = tc.id || genCallId();
            ids.push(id);
            blocks.push({
              type: "tool_use",
              id,
              name: (tc.function && tc.function.name) || "",
              input: jsonArgs(tc.function && tc.function.arguments),
            });
          }
          out.push({ role: "assistant", content: blocks });
          // Следующие подряд tool-результаты группируем в ОДНО user-сообщение с tool_result-блоками
          const results = [];
          let used = 0;
          while (i + 1 < messages.length && messages[i + 1].role === "tool") {
            i++;
            results.push({
              type: "tool_result",
              tool_use_id: messages[i].tool_call_id || ids[used] || genCallId(),
              content: messages[i].content || "",
            });
            used++;
          }
          if (results.length) out.push({ role: "user", content: results });
          continue;
        }
        if (m.role === "assistant") {
          out.push({ role: "assistant", content: m.content || "" });
          continue;
        }
        out.push({ role: "user", content: Array.isArray(m.content) ? contentForProvider("anthropic", m.content) : m.content });
      }
      return out;
    }
    return messages; // openai-совместимые — как есть (массив частей с image_url поддерживается нативно)
  }

  function systemText(messages) {
    return messages
      .filter((m) => m.role === "system")
      .map((m) => m.content || "")
      .filter(Boolean)
      .join("\n\n");
  }

  function toolsForProvider(provider, tools) {
    if (provider !== "anthropic") return tools || [];
    return (tools || []).map((t) => ({
      name: t.function && t.function.name,
      description: (t.function && t.function.description) || "",
      input_schema: (t.function && t.function.parameters) || { type: "object", properties: {} },
    }));
  }

  /**
   * Собирает HTTP-запрос к нужному провайдеру.
   * s — объект настроек: { provider, ollamaUrl, openaiUrl, anthropicUrl, openaiApiKey, anthropicApiKey }
   * opts — { model, messages, tools, fromBrowser }
   */
  function buildChatRequest(s, opts) {
    const provider = s && s.provider ? s.provider : "openai";
    const model = opts && opts.model;
    const messages = (opts && opts.messages) || [];
    const tools = (opts && opts.tools) || TOOL_DEFINITIONS;
    const fromBrowser = !!(opts && opts.fromBrowser);
    const apiKey = apiKeyFor(provider, s);
    const headers = apiHeaders(provider, apiKey, fromBrowser);

    if (provider === "ollama") {
      return {
        url: baseFor(provider, s) + "/api/chat",
        headers,
        body: JSON.stringify({ model, messages: messagesForProvider(provider, messages), tools, stream: true }),
      };
    }
    if (provider === "anthropic") {
      return {
        url: baseFor(provider, s) + "/v1/messages",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: systemText(messages),
          messages: messagesForProvider(provider, messages),
          tools: toolsForProvider(provider, tools),
          stream: true,
        }),
      };
    }
    return {
      url: baseFor(provider, s) + "/chat/completions",
      headers,
      body: JSON.stringify({ model, messages: messagesForProvider("openai", messages), tools, stream: true }),
    };
  }

  /**
   * Читает стрим ответа провайдера и вызывает колбэки:
   *   onText(text)     — очередной кусок текста (без обработки <think> — это делает вызывающий)
   *   onToolCall(call) — завершённый вызов инструмента { id, name, args } (аргументы — объект)
   *   onThinking(text) — нативные рассуждения модели: DeepSeek reasoning_content,
   *                      Anthropic thinking_delta (мысли приходят отдельным потоком)
   * Поддерживает NDJSON (Ollama), OpenAI-SSE и Anthropic-SSE.
   */
  async function consumeProviderStream({ response, provider, onText, onToolCall, onThinking }) {
    if (!response || !response.body) throw new Error("Пустой ответ от сервера (нет тела).");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Аккумуляция по индексу блока (OpenAI: tool_calls по index; Anthropic: content_block по index)
    const accum = new Map();
    const seenOllamaCalls = new Set();
    const finalizeAccum = () => {
      for (const item of accum.values()) {
        if (!item.name) continue;
        if (onToolCall) onToolCall({ id: item.id || genCallId(), name: item.name, args: jsonArgs(item.args) });
      }
      accum.clear();
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;

          if (provider === "ollama") {
            // NDJSON: каждая строка — полный JSON-объект
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            const msg = (obj && obj.message) || {};
            if (msg.content && onText) onText(msg.content);
            if (Array.isArray(msg.tool_calls)) {
              for (const tc of msg.tool_calls) {
                const f = tc.function || {};
                if (!f.name) continue;
                // Ollama в финальном (done:true) чанке может повторно прислать tool_calls —
                // дедуплицируем одинаковые вызовы в пределах одного стрима, чтобы инструмент
                // не выполнился дважды (двойное создание папки / двойной git commit).
                const args = jsonArgs(f.arguments);
                const sig = f.name + "|" + JSON.stringify(args);
                if (seenOllamaCalls.has(sig)) continue;
                seenOllamaCalls.add(sig);
                if (onToolCall) onToolCall({ id: tc.id || genCallId(), name: f.name, args });
              }
            }
            continue;
          }

          if (!line.startsWith("data:")) continue; // SSE (OpenAI/Anthropic): игнорируем event:-строки
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let obj;
          try { obj = JSON.parse(data); } catch { continue; }

          if (provider === "openai") {
            const choice = obj.choices && obj.choices[0];
            if (!choice) continue;
            const delta = choice.delta || {};
            if (delta.content && onText) onText(delta.content);
            // DeepSeek и другие OpenAI-совместимые шлют рассуждения отдельным полем
            if (delta.reasoning_content && onThinking) onThinking(delta.reasoning_content);
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const i = tc.index || 0;
                const cur = accum.get(i) || { id: "", name: "", args: "" };
                if (tc.id) cur.id = tc.id;
                const fn = tc.function || {};
                if (fn.name) cur.name = fn.name;
                if (fn.arguments) cur.args += fn.arguments;
                accum.set(i, cur);
              }
            }
          } else if (provider === "anthropic") {
            const type = obj.type;
            if (type === "content_block_start") {
              const block = obj.content_block || {};
              const cur = accum.get(obj.index) || { id: "", name: "", args: "" };
              if (block.type === "tool_use") {
                if (block.id) cur.id = block.id;
                if (block.name) cur.name = block.name;
              }
              accum.set(obj.index, cur);
            } else if (type === "content_block_delta") {
              const delta = obj.delta || {};
              const cur = accum.get(obj.index) || { id: "", name: "", args: "" };
              if (delta.type === "text_delta" && delta.text && onText) onText(delta.text);
              else if (delta.type === "thinking_delta" && delta.thinking && onThinking) onThinking(delta.thinking);
              else if (delta.type === "input_json_delta" && delta.partial_json) cur.args += delta.partial_json;
              accum.set(obj.index, cur);
            }
            // content_block_stop / message_delta / message_stop: ничего не делаем, финализируем ниже
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    finalizeAccum();
  }

  /** Возвращает список доступных моделей у выбранного провайдера (throws при ошибке). */
  async function listModels(s, opts) {
    const provider = s && s.provider ? s.provider : "openai";
    const fromBrowser = !!(opts && opts.fromBrowser);
    const apiKey = apiKeyFor(provider, s);
    const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined;
    const headers = apiHeaders(provider, apiKey, fromBrowser);

    if (provider === "ollama") {
      const res = await fetch(baseFor(provider, s) + "/api/tags", { headers, signal: timeout });
      if (!res.ok) throw new Error("Ollama error " + res.status + ": " + (await res.text()).slice(0, 300));
      const data = await res.json();
      return (data.models || []).map((m) => m.name);
    }
    if (provider === "anthropic") {
      const res = await fetch(baseFor(provider, s) + "/v1/models", { headers, signal: timeout });
      if (!res.ok) throw new Error("Claude API error " + res.status + ": " + (await res.text()).slice(0, 300));
      const data = await res.json();
      return (data.data || []).map((m) => m.id);
    }
    const res = await fetch(baseFor(provider, s) + "/models", { headers, signal: timeout });
    if (!res.ok) throw new Error("API error " + res.status + ": " + (await res.text()).slice(0, 300));
    const data = await res.json();
    return (data.data || []).map((m) => m.id);
  }

  /** Читает тело ошибочного ответа и возвращает человекочитаемый фрагмент. */
  async function readApiError(res) {
    const body = await res.text().catch(() => "");
    let detail = (body || "").slice(0, 600);
    try {
      const j = JSON.parse(body);
      const err = (j && j.error) || j;
      detail = typeof err === "string" ? err.slice(0, 600) : JSON.stringify(err, null, 2).slice(0, 600);
    } catch {}
    return detail;
  }

  // ── Вспомогательная модель (второй ключ): зрение + генерация изображений ──
  function auxConfig(s) {
    s = s || {};
    return {
      enabled: !!s.visionEnabled,
      auto: s.visionAuto !== false,
      url: ((s.visionUrl || "").trim() || (s.openaiUrl || "").trim() || "").replace(/\/+$/, ""),
      key: (s.visionKey || "").trim() || (s.openaiApiKey || "").trim() || "",
      visionModel: (s.visionModel || "").trim(),
      imageModel: (s.imageModel || "").trim(),
    };
  }

  // Чтение изображения vision-моделью: dataUrl → текстовое описание.
  async function describeImageRemote(cfg, imageDataUrl, prompt, model) {
    const res = await fetch(cfg.url + "/chat/completions", {
      method: "POST",
      headers: apiHeaders("openai", cfg.key),
      body: JSON.stringify({
        model,
        max_tokens: 2048,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt || "Опиши подробно, что изображено на картинке: объекты, текст, UI, цвета, расположение элементов." },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(180000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Vision: " + readApiError(res, data));
    const c = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (Array.isArray(c)) return c.map((p) => (p && p.text) || "").join("\n").trim();
    return String(c == null ? "" : c).trim();
  }

  // Генерация изображения: prompt → { buf, mediaType, ext }. Эндпоинт OpenRouter /images.
  async function generateImageRemote(cfg, prompt, model, opts) {
    opts = opts || {};
    const body = { model, prompt };
    if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
    if (opts.size) body.size = opts.size;
    const res = await fetch(cfg.url + "/images", {
      method: "POST",
      headers: apiHeaders("openai", cfg.key),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error("Генерация изображения: " + readApiError(res, data));
    const d = data && data.data && data.data[0];
    if (!d || !d.b64_json) {
      throw new Error("Модель не вернула изображение" + (data && data.error ? ": " + (data.error.message || JSON.stringify(data.error)) : ""));
    }
    const buf = Buffer.from(d.b64_json, "base64");
    const mediaType = String(d.media_type || "image/png").split(";")[0] || "image/png";
    const ext = "." + (mediaType.split("/")[1] || "png");
    return { buf, mediaType, ext };
  }

  return {
    SYSTEM_PROMPT,
    TOOL_DEFINITIONS,
    createThinkingStripper,
    stripThinking,
    normalizeToolName,
    normalizeToolArgs,
    extractToolCallsFromText,
    // транспорт провайдеров
    buildChatRequest,
    consumeProviderStream,
    listModels,
    readApiError,
    genCallId,
    // контекст
    estimateTokens,
    estimateMessageTokens,
    contextBudget,
    trimConversation,
    truncateText,
    // веб (общий для Electron main и preview-сервера)
    downloadHtml,
    webSearchDDG,
    webFetchPage,
    htmlToText,
    // вспомогательная модель: зрение + генерация изображений
    auxConfig,
    describeImageRemote,
    generateImageRemote,
  };
});
