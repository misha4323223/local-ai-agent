"use strict";

/* Общее ядро агента: системный промпт, определения инструментов, стриппер думающих блоков,
   а также унифицированный транспорт к трём семействам провайдеров:
     - "ollama"    — локальная Ollama (нативный /api/chat, NDJSON-стрим)
     - "openai"    — OpenAI-совместимые API (OpenAI, Groq, OpenRouter, DeepSeek, Yandex AI Studio, свой) — /chat/completions
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
19. Самосовершенствование: ты можешь улучшать собственный код этого приложения (src/, assets/) — это нормально и приветствуется. После правок обязательно прогони проверку синтаксиса (node --check по изменённым файлам), затем собери локальное OTA-обновление: node scripts/make-ota.js — приложение подхватит его в течение минуты и перезапустится с новым кодом. Это локальный self-update: пересборка EXE и GitHub не нужны. НЕ трогай src/bootstrap.js и src/ota.js — это критичная инфраструктура загрузки и обновления; их сломанный код выведет приложение из строя.
20. Windows и системные операции: для задач про саму ОС используй специальные инструменты, а не голые команды. Процессы: listProcesses (найти PID), killProcess (завершить зависший процесс — спросит подтверждение). Буфер обмена: clipboardWrite / clipboardRead. Скриншот экрана или окна (не страницы!) — screenshotDesktop (показывается пользователю во встроенном просмотрщике). Реестр Windows: registryRead (чтение разрешено только из разделов SOFTWARE, ENVIRONMENT, SYSTEM, SECURITY), registryWrite (запись только в HKCU\Software и HKCU\Environment, спросит подтверждение). Открыть файл системным приложением (PDF, картинка вне проекта) — openPath. Установка программ: installSystemPackage (на Windows сам выберет winget, choco или scoop; на macOS — brew, Linux — apt/dnf/apk), поиск пакета по имени — wingetSearch (Windows), установка скачанного установщика — installExe (умеет .exe, .msi и .zip; спросит подтверждение). ВАЖНО про оболочку: по умолчанию на Windows команды идут в cmd.exe, на macOS/Linux — в sh. Для PowerShell и bash есть параметр shell у runCommand и startBackground: shell: "powershell" — настоящий PowerShell с включённым UTF-8 (кириллица, $, кавычки и 2>$null работают как в консоли, обёртка powershell -Command не нужна), shell: "bash" — bash (на Windows это Git Bash, ставится вместе с Git for Windows), sh ищется там же. Если не знаешь, какие оболочки есть на машине, вызови shellsStatus — он покажет доступные с путями и подсказкой, что установить; не выясняй это методом проб (bash/sh на Windows без Git for Windows отсутствуют).
21. Браузер (видимое окно Chromium): открывай сайты через browserOpen (url) и СРАЗУ зови browserSnapshot — это карта кнопок и полей: ref (e1, e2…), роль и видимое имя (filter сужает список). Дальше действуй по ref, а НЕ перебирай селекторы: browserClick { ref: "e2" }, browserFill { ref: "e4", text: "..." }, browserSelect { ref: "e5", value: "..." }. Можно и словами: browserClick { name: "Войти" } (видимый текст кнопки), role+name («button» + «Войти»), для полей — label/placeholder; selector (CSS #id/.class, text=Текст, xpath=//...) тоже работает. Если элемент не найден, инструмент НЕ молчит, а вернёт похожие элементы с их ref — кликай по ним и не угадывай селекторы вслепую. После перехода на другую страницу ref устаревают — сделай browserSnapshot заново. Клавиши — browserPress (Enter), текст страницы — browserText, вкладки — browserStatus, скриншот — browserScreenshot. Окно видимое — пользователь видит каждое действие. Если появилась капча, 2FA или подтверждение — скажи пользователю дожать её в открытом окне и жди нужный элемент через browserWait. Логины и пароли сайтов бери из менеджера паролей: vaultList показывает сохранённые сайты (пароли не выводятся), vaultFill подставляет логин и пароль прямо в форму — поэтому НИКОГДА не проси пароль в чате (он попадёт в историю переписки) и не записывай его в код и в файлы. Если нужны СВОИ входы пользователя (его ВК, его почта, его кабинеты) — начни с browserConnect: приложение подключится к его Chrome по порту отладки и подхватит открытые вкладки, дальше те же browserSnapshot/browserClick/browserFill работают в них, а браузер пользователя не закрывается (browserClose с tabId: "all" лишь отключает агента). Сначала проверь через browserText, не авторизован ли ты уже: при включённом постоянном профиле сессия сохраняется между запусками. Если записи нет — попроси пользователя войти руками в открытом окне браузера (сессия сохранится) и предложи добавить запись в Настройках → 🔒 Секреты → «Пароли сайтов». После действий на странице проверяй результат через browserText (или browserScreenshot + analyzeImage), а не по памяти. Если сайт требует действий, которые агент не умеет (нестандартная капча, сложная JS-анимация) — честно сообщи и попроси пользователя сделать это вручную в том же окне.
22. СВОЁ окно приложения (app-инструменты): ты можешь управлять интерфейсом самого приложения, в котором работаешь: appRead — карта окна: кнопки/вкладки/поля со СТАБИЛЬНЫМ ref (e12), ролью и видимым именем, appClick — кликнуть по ref (или по видимому тексту: text «Сохранить»), appFill — ввести текст в поле по ref/label, appSelect — выбрать из списка, appPress — нажать клавишу (Enter, Escape), appWait — ждать элемента по ref/тексту, appScreenshot — скриншот окна (разбирается vision-моделью). ВАЖНО: номер [N] устаревает при любой перерисовке окна (после «↻ обновить», смены вкладки клик уходил в чужой элемент) — всегда бери ref из appRead и не полагайся на номер. Если действие не нашло элемент, инструмент сам вернёт свежую карту с ref — просто повтори по ней. appSelect/appPress — выбрать из списка/нажать клавишу, appSelect — выбрать из списка, appPress — нажать клавишу (Enter, Escape), appWait — ждать появления элемента, appScreenshot — скриншот окна (разбирается vision-моделью). Это удобно, чтобы самому открыть Настройки, выбрать провайдера, вписать модель и нажать «Сохранить». Не кликай по разрушительным кнопкам («Удалить», «Очистить чат», «Сбросить», «Отменить изменения») — для них спроси пользователя через askUser. После каждого действия проверяй результат через appRead, а не по памяти. В веб-превью app-инструменты недоступны — там просто сообщи, что это работает в desktop-приложении.
23. Остановка: если пользователь нажал Esc или кнопку «Стоп» (или ты получил результат «⏹ Остановлено пользователем») — немедленно прекрати вызывать инструменты, не начинай новых действий и заверши ответ КРАТКИМ итогом: что успел сделать и что осталось. Не продолжай «на всякий случай» — остановка означает остановку.
25. Проверка после правок: после серии изменений файлов запусти validateProject (типчек + линт + тесты, если они есть) — не рапортуй «готово», пока проверка не зелёная. Если что-то упало — исправь ошибки и перепроверь. Когда тесты медленные — можно ограничиться точечной проверкой через runCommand (например tsc --noEmit), но типчек при наличии tsconfig.json обязателен.
26. Семантический поиск: semanticSearch(query) ищет по коду проекта по смыслу (стебли слов, camelCase/snake_case, BM25-ранжирование) и показывает сниппеты с номерами строк. Используй его для поиска «где находится X» и «как устроен Y» — быстрее и точнее, чем читать файлы подряд. Точный регулярный поиск — searchFile/searchProject.
24. Память проекта и точки отката: заметки (noteSave/noteRead/noteList/noteDelete) — твоя долговременная память о проекте, она переживает перезапуск приложения. Сохраняй решения, архитектуру, договорённости и важные выводы; в начале новой сессии прочитай их через noteRead. Перед серией рискованных правок или рефакторингом создавай точку отката checkpointSave(label); если что-то сломалось — верни всё разом через checkpointRollback(id) (список — checkpointList). Память диалогов: когда контекст переполняется, старые шаги сворачиваются в памятку — если в настройках включена галочка «Память диалогов», приложение сохраняет такие памятки локально по датам. memoryList показывает дни и памятки за конкретный день (date: ГГГГ-ММ-ДД), memorySearch ищет по ним слова и фразы. Это помогает вспомнить прошлые сессии: «посмотри, что мы делали 5-го числа».
27. Самоизменения и OTA: перед любой правкой собственного кода (src/, assets/) сначала создай точку отката checkpointSave(label — «перед самоизменением …»). Файлы src/bootstrap.js и src/ota.js и папка применённого OTA-бандла физически заблокированы: writeFile/editFile/applyPatch вернут ошибку — не пытайся их обойти. После сборки бандла (node scripts/make-ota.js) вызови otaStatus (видно ли обновление) и otaCheck (применить); после применения — validateProject; если после обновления что-то сломалось — otaRollback.
28. Yandex Cloud: инструменты ycStatus / ycList / ycCreate / ycDelete / ycDeploy / ycLogs / ycInstall. Начни с ycStatus — авторизация (Настройки → «☁️ Yandex Cloud»), каталог, разрешения агента. Создание/удаление ресурсов — только по явной просьбе пользователя и при включённых чекбоксах разрешений (ресурсы платные, удаление необратимо). Создать можно: ydb, lockbox, containerRegistry, storage, dns, serverlessContainers, vpc. Деплой — ycDeploy (directory, name, public): Docker-образ → Container Registry → Serverless Container → URL (нужен Docker). Логи — ycLogs (id, service необязателен): читаются внутренним API Cloud Logging — записи по gRPC с хоста log-reading, список групп по REST — внешний yc CLI НЕ нужен. Если в песочнице нужен сам yc CLI (например, команда yc в терминале) — вызови ycInstall: он скачает официальный бинарь в папку приложения и добавит в PATH. Токен и каталог уже подставляются автоматически (YC_IAM_TOKEN — свежий IAM-токен, YC_CLOUD_ID, YC_FOLDER_ID), yc init не нужен. Результат проверяй через ycList.
29. ВКонтакте (vk.com/vk.ru — домены взаимозаменяемы): браузерные инструменты. Поле ввода — contenteditable, селектор [role=textbox]: browserClick по полю → browserFill(selector: [role=textbox], text: ...) → отправка browserPress(key: Enter) (Shift+Enter — перенос строки). Страницы грузятся лениво — после открытия жди 2–5 секунд и перечитывай browserText; проверка отправки — текст сообщения в конце переписки. Работай в СУЩЕСТВУЮЩЕЙ вкладке браузера (новые открываются без сессии); состояние читай через browserText, а не скриншоты (ВК их обрезает); текст приходит вместе с левым меню — фильтруй по именам/датам. Вход/сессия — только руками пользователя, не обходи. Маршруты, селекторы, сценарии и известные контакты — в гайде, прочитай перед работой: readFile(path: agent-guide:vk).
30. Анализ переписок (ВК, чаты, письма, файлы): определи КТО человек по уликам в тексте (работа/задачи → коллега; семейное/личное → родственник/друг; услуги/цены/заказы → клиент/поставщик; «Вы» и официальный тон → деловой контакт), выдели СУТЬ (2–4 предложения: о чём разговор, что решено, что ждёт ответа, срочность) и оформи ТАБЛИЦЕЙ: «Человек (профиль) | Кто он | Суть переписки | Важность | Следующий шаг». Для КЛИЕНТОВ дополнительно: профиль (потребность его словами, что обсуждали, бюджет/сроки если видно, возражения, тон) + фундамент для КП (2–4 пункта, что включить в предложение, и следующий логичный шаг). Не выдумывай: чего нет в тексте — «не определено». Длинную историю читай частями (PageUp + browserText). Полная методология — readFile(path: agent-guide:chat-analysis).
31. Почта (SMTP/IMAP, Настройки → «✉️ Почта»): mailList — прочитать последние письма (отправитель, тема, дата, найденный код), mailCode — вытащить код подтверждения (from — фильтр по отправителю, например «yandex»), mailSend — отправить письмо (КП клиенту, ответ на запрос). Начни с mailList: если почта не настроена или нет разрешения на отправку, инструмент вернёт подсказку — передай её пользователю. Письма уходят с его ящика, поэтому перед отправкой клиенту покажи готовый текст и спроси подтверждение, если пользователь не просил отправить сразу. Пароль приложения не показывай и не проси в чате. Если письмо с кодом ещё не пришло — повтори mailCode через 10–20 секунд (письмо доходит не мгновенно).
32. План работ (todoWrite): многошаговую задачу (от 3 шагов: «собери/починь/проверь», рефакторинг, диагностика) начинай с todoWrite — составь план из 3–7 коротких пунктов. Он показывается пользователю панелью-чеклистом с прогрессом, поэтому не дублируй его в тексте ответа. После КАЖДОГО выполненного пункта вызывай todoWrite снова, присылая полный список: текущий пункт — in_progress, сделанные — done, сорвавшийся — failed с пометкой note (по какой причине). Работай строго по плану и не расширяй объём самовольно; если по ходу выясняется, что план неверен — перепиши его тем же инструментом. Когда все пункты done — коротко подведи итог. В режиме плана («📋 План-режим») todoWrite обязателен: сначала покажи план и жди команды пользователя.

Доступные инструменты: createFolder, readFile, readFileLines, writeFile, editFile, searchFile, listDirectory, runCommand, webSearch, webFetch, gitClone, gitStatus, gitCommit, gitPush, gitPublish, gitPull, gitLog, gitRevert, askUser, startBackground, listBackground, backgroundOutput, sendInput, stopBackground, shellStart, shellSend, checkUrl, openUrl, showImage, checkPort, listPorts, dockerBuild, dockerRun, dockerExec, installPackage, lintProject, runTests, diffView, previewUI, screenshotCapture, envSet, envList, envUnset, fileOutline, readFileStructure, explainCode, undoEdit, refactorRename, runCommandOutput, retryCommand, timeoutCommand, shellsStatus, checkInstalledProgram, canExecute, installSystemPackage, runCommandAsAdmin, refreshEnv, getSystemInfo, explainError, downloadAndExtract, apiRequest, runScript, validateProject, gitBranch, gitDiff, gitUndoLastCommit, gitInit, getDependencies, formatCode, dbQuery, gitCheckout, findReferences, analyzeImage, generateImage, listProcesses, killProcess, clipboardRead, clipboardWrite, screenshotDesktop, registryRead, registryWrite, openPath, wingetSearch, installExe, browserConnect, browserOpen, browserSnapshot, browserFill, browserClick, browserSelect, browserPress, browserText, browserScreenshot, browserWait, browserClose, browserStatus, browserClearProfile, vaultList, vaultFill, mailSend, mailList, mailCode, appRead, appClick, appFill, appSelect, appPress, appWait, appScreenshot, noteSave, noteRead, noteList, noteDelete, memoryList, memorySearch, todoWrite, checkpointSave, checkpointList, checkpointRollback, applyPatch, waitUntil, gitStash, gitCherryPick, gitBlame, semanticSearch, otaStatus, otaCheck, otaRollback, ycStatus, ycList, ycCreate, ycDelete, ycDeploy, ycLogs, ycInstall.`;

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
        description: "Выгрузить папку проекта в удалённый репозиторий. По умолчанию создаёт НОВЫЙ репозиторий на GitHub (git init при необходимости, первый коммит и push). Для GitLab, Bitbucket или своего сервера передай remoteUrl (https://gitlab.com/you/repo.git или git@bitbucket.org:you/repo.git) — репозиторий создаётся на сайте хостинга, инструмент сам пропишет remote и отправит ветку. Требует включённой настройки «Разрешить агенту git push».",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Имя нового репозитория (буквы/цифры/точка/дефис/подчёркивание, без пробелов). По умолчанию — имя текущей папки." },
            description: { type: "string", description: "Краткое описание репозитория (необязательно)." },
            private: { type: "boolean", description: "Приватный репозиторий? По умолчанию true." },
            message: { type: "string", description: "Сообщение первого коммита (по умолчанию Initial commit)." },
            directory: { type: "string", description: "Папка проекта (по умолчанию — рабочая папка агента)." },
            remoteUrl: { type: "string", description: "git-адрес не-GitHub хостинга (GitLab, Bitbucket, свой сервер). Если задан — инструмент прописывает remote и отправляет ветку вместо создания репозитория на GitHub." },
            remoteName: { type: "string", description: "Имя remote (по умолчанию origin)." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitInit",
        description: "Создать НОВЫЙ ЛОКАЛЬНЫЙ git-репозиторий в папке (git init, ветка main) — БЕЗ GitHub и без сети. Удобно для нового проекта: файлы уже созданы, теперь зафиксировать их в git локально. directory — (необязательно) папка проекта, по умолчанию рабочая директория; message — (необязательно) текст первого коммита: если задан, сразу делается первый коммит всех файлов. Для публикации позже есть gitPublish/gitPush.",
        parameters: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Папка, где создать репозиторий (по умолчанию — рабочая директория)" },
            message: { type: "string", description: "Необязательно: сообщение первого коммита" },
          },
          required: [],
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
          properties: {
            command: { type: "string", description: "Команда для выполнения в терминале" },
            shell: { type: "string", description: "Оболочка: cmd (по умолчанию на Windows), powershell, pwsh, bash, sh. Выбирай powershell для командлетов и объектов PowerShell — кавычки, $ и 2>$null работают как в обычной консоли." },
            timeoutMs: { type: "integer", description: "Таймаут в миллисекундах (по умолчанию 120000, максимум 300000)" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "shellsStatus",
        description: "Показать, какие оболочки реально доступны на машине: cmd, powershell, pwsh, bash, sh — с путями и подсказкой, что установить, если чего-то нет. Вызывай ПЕРЕД первым запуском команд с параметром shell (особенно bash/sh на Windows — они появляются только вместе с Git for Windows), чтобы не выяснять доступность пробами и ошибками.",
        parameters: { type: "object", properties: {} },
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
        name: "browserSnapshot",
        description: "Карта страницы: список интерактивных элементов (кнопки, ссылки, поля, чекбоксы) с коротким ref (e1, e2…), ролью и видимым именем. ВЫЗЫВАЙ ПЕРЕД первым действием на странице — вместо угадывания селекторов возьми ref нужной кнопки: browserClick { ref: \"e2\" }, browserFill { ref: \"e4\", text: \"...\" }. filter — сузить список (часть имени или роли, например «войти»); limit — сколько строк показать (по умолчанию 60).",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            filter: { type: "string", description: "Показать только элементы, где встречается этот текст (имя, роль, id)" },
            limit: { type: "integer", description: "Максимум строк (5–200, по умолчанию 60)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserConnect",
        description: "Подключиться к СВОЕМУ Chrome пользователя через порт отладки (CDP) — тогда все браузерные инструменты работают в его вкладках с его входами на сайты (ВК, почта, кабинеты), а не в отдельном окне агента. Если Chrome с портом отладки не запущен, приложение само запустит его со своим профилем (входы сохранятся). Уже открытые вкладки пользователя подхватываются — работай в них; агент их не закрывает. Отключиться: browserClose с tabId: \"all\" — Chrome пользователя продолжит работать.",
        parameters: {
          type: "object",
          properties: {
            port: { type: "integer", description: "Порт отладки Chrome (по умолчанию 9222)" },
            launch: { type: "boolean", description: "Запустить Chrome, если он не запущен с отладкой (по умолчанию да)" },
            browser: { type: "string", description: "Какой браузер запускать: chrome или edge" },
            url: { type: "string", description: "Сразу открыть этот адрес после подключения" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserOpen",
        description: "Открыть сайт в видимом окне Chromium агента (пользователь видит всё). url — полный адрес страницы; newTab — true, чтобы открыть новую вкладку вместо активной. Возвращает id вкладки (tabId). Если нужны входы пользователя — сначала browserConnect (свой Chrome по CDP).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL страницы, например https://..." },
            newTab: { type: "boolean", description: "Открыть в новой вкладке (по умолчанию переиспользуется активная)" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserFill",
        description: "Заполнить текстовое поле. Поле указывай ОДНИМ способом: ref из browserSnapshot (ref: \"e4\" — самый надёжный), label/placeholder (видимая подпись или подсказка поля), name (то же, что label), role+name или selector (CSS #id/.class, text=..., xpath=...). Поддерживаются обычные поля и contenteditable (ВК).",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            ref: { type: "string", description: "ref элемента из browserSnapshot, например e4" },
            selector: { type: "string", description: "Селектор поля: #id, .class, input[name=...], text=..., xpath=..." },
            label: { type: "string", description: "Видимая подпись поля (label) или aria-label" },
            placeholder: { type: "string", description: "Подсказка внутри поля (placeholder)" },
            name: { type: "string", description: "Название поля или его id/name" },
            role: { type: "string", description: "Роль поля: textbox, searchbox, combobox" },
            text: { type: "string", description: "Значение для ввода" },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserClick",
        description: "Кликнуть по элементу (кнопка, ссылка, чекбокс, пункт меню). Указывай ОДИН способ: ref из browserSnapshot (ref: \"e2\" — самый надёжный), name (видимый текст, например name: \"Войти\"), role+name (role: \"button\", name: \"Войти\"), text (то же, что name) или selector (CSS #id, text=Кнопка, xpath=...). Если элемент не найден — вернёт похожие элементы с ref (по ним и кликай, не перебирай селекторы). waitLoad: false — не ждать загрузки после клика.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            ref: { type: "string", description: "ref элемента из browserSnapshot, например e2" },
            name: { type: "string", description: "Видимый текст кнопки/ссылки, например «Войти»" },
            role: { type: "string", description: "Роль элемента: button, link, checkbox, radio, tab, menuitem" },
            text: { type: "string", description: "Текст элемента (то же, что name)" },
            selector: { type: "string", description: "Селектор элемента: #id, .class, text=Кнопка, xpath=..." },
            waitLoad: { type: "boolean", description: "Ждать загрузку страницы после клика (по умолчанию true)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserSelect",
        description: "Выбрать вариант в выпадающем списке (<select>). Список указывай через ref из browserSnapshot, label (видимая подпись) или selector; value — значение варианта. Если варианта нет, вернёт реальные варианты списка.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            ref: { type: "string", description: "ref списка из browserSnapshot" },
            selector: { type: "string", description: "Селектор списка" },
            label: { type: "string", description: "Видимая подпись списка" },
            value: { type: "string", description: "Значение варианта (атрибут value)" },
          },
          required: ["value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserPress",
        description: "Нажать клавишу на открытой странице (Enter — отправка формы, Escape, Tab, стрелки). tabId — id вкладки; key — имя клавиши (Enter, Escape, Tab, ArrowDown...).",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            key: { type: "string", description: "Клавиша: Enter, Escape, Tab, ArrowDown и т.п." },
          },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserText",
        description: "Прочитать видимый текст открытой страницы (до max символов, по умолчанию 12000). Возвращает URL, заголовок и текст. Используй, чтобы понять, что на странице, после кликов/заполнения. tabId — id вкладки.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            max: { type: "integer", description: "Максимум символов (1000–30000, по умолчанию 12000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserScreenshot",
        description: "Сделать скриншот открытой страницы (PNG data URL). fullPage — true, чтобы захватить всю длину страницы. Результат можно передать в analyzeImage (разбор глазами vision-модели) или показать пользователю через showImage. tabId — id вкладки.",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            fullPage: { type: "boolean", description: "Скриншот всей страницы (по умолчанию только видимая часть)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserWait",
        description: "Ждать появления элемента (загрузка после входа, капча, кнопка). Элемент можно описать словами: name/text (видимый текст), ref из browserSnapshot или selector. timeout — мс ожидания (по умолчанию 10000, максимум 60000).",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
            name: { type: "string", description: "Видимый текст ожидаемого элемента" },
            text: { type: "string", description: "То же, что name" },
            ref: { type: "string", description: "ref элемента из browserSnapshot" },
            role: { type: "string", description: "Роль: button, link, textbox, checkbox…" },
            selector: { type: "string", description: "Селектор ожидаемого элемента" },
            timeout: { type: "integer", description: "Таймаут в мс (по умолчанию 10000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserClose",
        description: "Закрыть вкладку (tabId, по умолчанию активную) или все вкладки и браузер (tabId: \"all\").",
        parameters: {
          type: "object",
          properties: {
            tabId: { type: "string", description: "id вкладки или \"all\" для закрытия всего браузера" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserStatus",
        description: "Показать состояние браузера: список открытых вкладок (id, заголовок, URL) и какая из них активная. Без аргументов.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function",
      function: {
        name: "browserClearProfile",
        description: "Очистить постоянный профиль браузера: закрыть браузер и стереть куки, localStorage и сессии всех сайтов. Используй, только если пользователь сам попросил «выйти со всех сайтов / очистить браузер агента» — после этого придётся авторизовываться заново.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "vaultList",
        description: "Показать сохранённые в менеджере паролей сайты: название, адрес, логин и есть ли пароль. Пароли НИКОГДА не возвращаются — они подставляются только инструментом vaultFill. Без аргументов. Вызывай перед тем, как просить у пользователя логин.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "vaultFill",
        description: "Подставить сохранённые логин и пароль в форму входа на открытой странице. Пароль берётся из менеджера паролей и уходит напрямую в браузер — в чат он не попадает, поэтому пароль в чате не спрашивай. site — название сайта или адрес («ВК», «vk.com»). submit:true — сразу отправить форму клавишей Enter (по умолчанию false: сначала проверь поля).",
        parameters: {
          type: "object",
          properties: {
            site: { type: "string", description: "Название сайта или адрес из vaultList (например «ВК» или vk.com)" },
            submit: { type: "boolean", description: "Отправить форму сразу после заполнения (Enter). По умолчанию false" },
            loginSelector: { type: "string", description: "Свой CSS-селектор поля логина (если автоопределение не сработало)" },
            passwordSelector: { type: "string", description: "Свой CSS-селектор поля пароля" },
            tabId: { type: "string", description: "id вкладки (необязательно, по умолчанию активная)" },
          },
          required: ["site"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mailSend",
        description: "Отправить письмо по электронной почте (например коммерческое предложение клиенту). to — адрес или несколько через запятую; subject — тема; text — текст письма (можно с переносами строк); html — необязательная HTML-версия. Требует двух условий: настроенного пароля приложения (Настройки → «✉️ Почта») и включённого разрешения «Разрешить агенту отправлять письма». Письмо уходит с ящика пользователя — перед отправкой клиенту покажи готовый текст и попроси подтверждение, если пользователь не просил отправить сразу.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Адрес получателя (или несколько через запятую)" },
            subject: { type: "string", description: "Тема письма" },
            text: { type: "string", description: "Текст письма (обычный текст)" },
            html: { type: "string", description: "HTML-версия письма (необязательно)" },
          },
          required: ["to", "subject", "text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mailList",
        description: "Прочитать последние входящие письма: отправитель, тема, дата, найденный код подтверждения и первые строки текста. limit — сколько писем (по умолчанию 5, максимум 10); unseenOnly: true — только непрочитанные. Используй, чтобы найти код подтверждения при регистрации на сайте или письмо от клиента.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", description: "Сколько последних писем вернуть (1–10, по умолчанию 5)" },
            unseenOnly: { type: "boolean", description: "Только непрочитанные письма (по умолчанию false)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "mailCode",
        description: "Найти код подтверждения в свежих письмах (для регистрации или входа на сайтах). from — необязательный фильтр по отправителю или теме («yandex», «gosuslugi»). Возвращает сам код и письмо, в котором он найден. Вызывай после того, как сайт запросил код: письмо приходит в течение минуты.",
        parameters: {
          type: "object",
          properties: {
            from: { type: "string", description: "Фильтр по отправителю или теме письма (необязательно)" },
            limit: { type: "integer", description: "Сколько последних писем проверить (по умолчанию 5, максимум 10)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appRead",
        description: "Карта собственного окна приложения: видимые кнопки, вкладки, поля и списки — каждая строка это ref (e12), роль, видимое имя, id/класс; плюс открытые панели и фрагмент текста. Без аргументов. Вызывай перед действием в UI и после него. ref стабильны, пока элемент жив; после перерисовки окна (обновление списков, смена вкладки) сделай appRead заново. Ищи нужную строку глазами по имени кнопки — и кликай по её ref.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "appClick",
        description: "Кликнуть по элементу в собственном окне приложения. Указывай ОДИН способ: ref из appRead (ref: \"e12\" — самый надёжный), text — видимый текст («Настройки», «Сохранить»), role+text, или selector (#id/.class). Поле index (номер [N]) принимается только для совместимости: номер ломается при перерисовке окна, поэтому он не рекомендуется. Клики по разрушительным кнопкам («Удалить», «Очистить чат», «Сбросить», «Отменить изменения») заблокированы — для них спроси пользователя через askUser. Если элемент не найден, вернётся свежая карта с ref — кликай по ней. После клика проверяй результат через appRead.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "ref элемента из appRead, например e12" },
            text: { type: "string", description: "Видимый текст элемента (кнопка, вкладка, пункт меню)" },
            role: { type: "string", description: "Роль: button, link, tab, checkbox (необязательно)" },
            selector: { type: "string", description: "CSS-селектор: #id или .class" },
            index: { type: "integer", description: "Устарело: номер [N] из appRead (ненадёжен при перерисовке)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appFill",
        description: "Ввести текст в поле ввода в собственном окне приложения (URL провайдера, модель, путь и т.п.). Поле указывай через ref из appRead (ref: \"e4\" — надёжнее всего), label/placeholder (видимая подпись или подсказка) или selector (#id/.class). text — вводимое значение. Работает с обычными и React-управляемыми полями. Значения бери ТОЛЬКО из настроек или от пользователя; значения секретных полей (пароли, токены) в ответ не выводятся.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "ref поля из appRead, например e4" },
            selector: { type: "string", description: "Селектор поля: #id, .class, input[name=...]" },
            label: { type: "string", description: "Видимая подпись поля (label)" },
            placeholder: { type: "string", description: "Подсказка внутри поля" },
            text: { type: "string", description: "Значение для ввода" },
          },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appSelect",
        description: "Выбрать вариант в выпадающем списке (<select>) в собственном окне приложения. Список указывай через ref из appRead, label (видимая подпись) или selector; value — атрибут value варианта, text — видимый текст варианта. Если варианта нет, вернёт реальный список вариантов.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "ref списка из appRead" },
            selector: { type: "string", description: "Селектор списка" },
            label: { type: "string", description: "Видимая подпись списка" },
            value: { type: "string", description: "Значение варианта (атрибут value)" },
            text: { type: "string", description: "Или видимый текст варианта" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appPress",
        description: "Нажать клавишу в собственном окне приложения: Enter (отправка/подтверждение), Escape (закрыть оверлей/окно настроек), Tab, ArrowDown и т.п. key — имя клавиши.",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "Клавиша: Enter, Escape, Tab, ArrowDown..." } },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appWait",
        description: "Ждать появления элемента в собственном окне приложения (после открытия панели, загрузки списка, действий пользователя). Указывай ref из appRead, видимый text или selector; timeout — миллисекунды ожидания (по умолчанию 20000).",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "ref ожидаемого элемента из appRead" },
            text: { type: "string", description: "Видимый текст ожидаемого элемента" },
            selector: { type: "string", description: "CSS-селектор ожидаемого элемента" },
            timeout: { type: "integer", description: "Таймаут в миллисекундах (по умолчанию 20000)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "appScreenshot",
        description: "Сделать скриншот собственного окна приложения и показать его пользователю. Нужен, когда надо реально «посмотреть» на UI (подходит vision-модель через analyzeImage); для обычного чтения состояния используй appRead — он точнее и без картинок.",
        parameters: { type: "object", properties: {} },
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
            shell: { type: "string", description: "Оболочка: cmd, powershell, pwsh, bash, sh (по умолчанию cmd на Windows, sh на macOS/Linux)" },
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
        description: "Сделать скриншот страницы по URL (невидимое окно, ждёт загрузки и отрисовки), показать пользователю во встроенном просмотрщике и сохранить PNG на диск — в ответе вернётся путь к файлу. Чтобы понять, что на экране, сразу вызови analyzeImage(path: <этот путь>) — вспомогательная vision-модель вернёт текстовое описание UI. Незаменимо для проверки вёрстки. url — полный адрес страницы.",
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
    {
      type: "function",
      function: {
        name: "listProcesses",
        description: "Список запущенных процессов ОС (Windows: tasklist; macOS/Linux: ps). filter — необязательная подстрока имени или пути для фильтрации (например node, expo, chrome). Нужен, чтобы найти PID зависшего процесса перед killProcess.",
        parameters: {
          type: "object",
          properties: { filter: { type: "string", description: "Необязательно: подстрока имени/пути процесса" } },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "killProcess",
        description: "Завершить процесс по PID или имени (например зависший node.exe, expo, браузер). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ пользователя. pid — числовой ID из listProcesses; name — имя процесса (на Windows без расширения, например node); force — принудительное завершение (Windows: /F). На Windows завершается всё дерево процесса.",
        parameters: {
          type: "object",
          properties: { pid: { type: "integer", description: "PID процесса (из listProcesses)" }, name: { type: "string", description: "Имя процесса вместо PID, например node" }, force: { type: "boolean", description: "Принудительно (по умолчанию false)" } },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clipboardWrite",
        description: "Скопировать текст в системный буфер обмена (пользователь сможет вставить его куда угодно). text — что копировать.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "Текст для копирования" } },
          required: ["text"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clipboardRead",
        description: "Прочитать текущий текст из системного буфера обмена (то, что скопировал пользователь). Полезно, когда пользователь просит «прочитай, что я скопировал» или даёт команду из буфера.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "screenshotDesktop",
        description: "Скриншот ЭКРАНА или окна Windows (не страницы — для страниц есть screenshotCapture). window — необязательная подстрока заголовка окна (например «Блокнот», «chrome»); без неё снимается весь экран. Скриншот показывается пользователю и сохраняется PNG на диск — в ответе вернётся путь. Чтобы понять, что на экране, сразу вызови analyzeImage(path: <этот путь>) — вспомогательная vision-модель вернёт описание.",
        parameters: {
          type: "object",
          properties: { window: { type: "string", description: "Необязательно: подстрока заголовка окна" } },
          required: [],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "registryRead",
        description: "Прочитать значение из реестра Windows (только на Windows). path — раздел вида HKCU\Software\MyApp или HKLM\Software\...; name — имя значения (без name — значение по умолчанию). Чтение разрешено только из разделов SOFTWARE, ENVIRONMENT, SYSTEM, SECURITY.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь в реестре, например HKCU\Software\MyApp" }, name: { type: "string", description: "Имя значения (необязательно)" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "registryWrite",
        description: "Записать значение в реестр Windows (только на Windows, ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ). path — раздел ТОЛЬКО под HKCU\Software или HKCU\Environment; name — имя значения; value — значение; type — REG_SZ (строка), REG_DWORD (число) или REG_EXPAND_SZ. Для HKLM нужен администратор (runCommandAsAdmin).",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь под HKCU\Software или HKCU\Environment" }, name: { type: "string", description: "Имя значения" }, value: { type: "string", description: "Значение" }, type: { type: "string", description: "REG_SZ | REG_DWORD | REG_EXPAND_SZ (по умолчанию REG_SZ)" } },
          required: ["path","name","value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "openPath",
        description: "Открыть файл или папку системным приложением (PDF в просмотрщике, картинку, документ, папку в проводнике/файловом менеджере). path — путь к файлу/папке (относительный — от рабочей директории).",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Путь к файлу или папке" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "wingetSearch",
        description: "Поиск программы в каталоге winget (только на Windows) по имени — вернёт список с точными ID вида Vendor.Name. Затем установка: installSystemPackage('Vendor.Name').",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Поисковый запрос, например python, ffmpeg, ollama" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "installExe",
        description: "Скачать установщик по прямой ссылке и запустить его (ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ). Поддерживаются .exe (запуск), .msi (через msiexec) и .zip (распаковка + поиск установщика внутри). url — прямая ссылка; name — имя программы (для проверки после установки); silentArgs — аргументы тихой установки (для .exe по умолчанию /S, для .msi — /passive /norestart); run: true — сразу запустить найденный в архиве установщик. Если установка требует прав администратора — приложение подскажет runCommandAsAdmin.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Прямая ссылка на установщик .exe (https://...)" }, name: { type: "string", description: "Имя программы (необязательно)" }, silentArgs: { type: "string", description: "Аргументы тихой установки (по умолчанию /S)" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "noteSave",
        description: "Сохранить заметку проекта под ключом key (латиница/цифры/точка/дефис/подчёркивание, до 64 символов). Заметки переживают перезапуск и видны в следующих сессиях — это твоя долговременная память о проекте: архитектура, решения, договорённости, что уже сделано. Перезаписывает заметку с тем же key. Содержимое — до 6000 символов.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Короткое имя заметки, например architecture, todos, decisions, api-notes" },
            content: { type: "string", description: "Текст заметки (до 6000 символов)" },
          },
          required: ["key", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "noteRead",
        description: "Прочитать заметки проекта. Без key — все заметки (свежие первыми); с key — одну заметку. Используй в начале работы и при сомнении о договорённостях или состоянии проекта.",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "Имя заметки (необязательно; без него — все)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "noteList",
        description: "Показать только ключи всех заметок проекта (без содержимого).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "noteDelete",
        description: "Удалить заметку проекта по ключу.",
        parameters: {
          type: "object",
          properties: { key: { type: "string", description: "Имя заметки для удаления" } },
          required: ["key"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "todoWrite",
        description:
          "План работ для многошаговой задачи: показывается пользователю отдельной панелью-чеклистом с прогрессом и виден между перезапусками. " +
          "Вызывай В НАЧАЛЕ многошаговой задачи (от 3 шагов) и повторно — после каждого выполненного шага, присылая ПОЛНЫЙ список с обновлёнными статусами. " +
          "tasks: массив пунктов (до 7). Каждый пункт — либо строка с текстом, либо объект { text, status, note }, где status: pending (ожидает), in_progress (в работе), done (готово), failed (не удалось), note — короткая пометка (например, причина ошибки). " +
          "Ровно один пункт может быть in_progress — тот, который делаешь сейчас. Не пересказывай план в тексте ответа: он и так виден пользователю.",
        parameters: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              description: "Полный список пунктов плана (до 7). Строка или объект { text, status, note }.",
              items: {
                type: "object",
                properties: {
                  text: { type: "string", description: "Короткий пункт плана" },
                  status: { type: "string", description: "pending | in_progress | done | failed" },
                  note: { type: "string", description: "Короткая пометка к пункту (необязательно)" },
                },
                required: ["text"],
              },
            },
            title: { type: "string", description: "Название плана (необязательно), например «Починка ycLogs»" },
          },
          required: ["tasks"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memoryList",
        description:
          "Дневник сжатых памяток контекста (память диалогов). Без date — список дней с количеством памяток; с date (ГГГГ-ММ-ДД) — памятки за этот день: время, провайдер/модель, рабочая папка и текст. Это то, что агент сворачивал в памятку, когда контекст переполнялся, — помогает вспомнить, что делали в прошлые сессии. Работает, только если в настройках включена галочка «Память диалогов» (по умолчанию выключена).",
        parameters: {
          type: "object",
          properties: {
            date: { type: "string", description: "Дата ГГГГ-ММ-ДД (необязательно; без неё — список дней)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memorySearch",
        description:
          "Поиск по дневнику сжатых памяток контекста (память диалогов): найти, о чём говорили и что делали раньше. Возвращает дату, время, число совпадений и фрагмент памятки. Можно ограничить одной датой (date) и задать limit. Используй, когда пользователь спрашивает «что мы делали 5-го числа» или «когда мы правили X».",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Что искать — слово или фраза" },
            date: { type: "string", description: "Ограничить датой ГГГГ-ММ-ДД (необязательно)" },
            limit: { type: "number", description: "Сколько совпадений вернуть (по умолчанию 20)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkpointSave",
        description: "Создать точку отката: полный снимок текстовых файлов рабочей директории (без .git, node_modules, dist, build и т.п.). Делай ПЕРЕД серией рискованных правок или рефакторингом — потом можно вернуть всё разом через checkpointRollback(id). Хранится до 15 чекпоинтов, старые вытесняются.",
        parameters: {
          type: "object",
          properties: { label: { type: "string", description: "Короткая подпись, например «до рефакторинга api» (необязательно)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "checkpointList",
        description: "Показать все точки отката: id, подпись, дата, число файлов.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "checkpointRollback",
        description: "Откатить рабочую директорию к точке отката: восстановить все файлы из снимка checkpointSave (перезаписывает текущее содержимое). Файлы, созданные после чекпоинта, не удаляются. Используй, когда серия правок сломала проект.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Идентификатор чекпоинта (из checkpointList)" } },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "applyPatch",
        description: "Применить unified diff (формат git diff) — правка нескольких файлов одним вызовом. patch — текст диффа с заголовками --- / +++ и хунками @@. Изменяет существующие файлы, создаёт новые (--- /dev/null), удаляет файлы (+++ /dev/null). basePath — папка, относительно которой идут пути (по умолчанию рабочая директория). Генерируй патч аккуратно: контекст должен точно совпадать с содержимым файлов (перечитай их через readFile). После применения запусти validateProject.",
        parameters: {
          type: "object",
          properties: {
            patch: { type: "string", description: "Unified diff (git diff): --- a/путь, +++ b/путь, хунки @@ -N,M +N,M @@" },
            basePath: { type: "string", description: "Базовая папка для путей из патча (по умолчанию — рабочая директория)" },
          },
          required: ["patch"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "waitUntil",
        description: "Подождать seconds секунд (1–300) и вернуться. Используй перед повторной проверкой состояния: сервер ещё стартует (checkPort/checkUrl), тест ещё работает, файл должен появиться. Сразу после — перепроверь то, ради чего ждал.",
        parameters: {
          type: "object",
          properties: {
            seconds: { type: "integer", description: "Сколько секунд ждать (1–300)" },
            reason: { type: "string", description: "Зачем ждём (показывается пользователю)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitStash",
        description: "Работа со stash git: action push — спрятать незакоммиченные изменения и очистить рабочее дерево (message — подпись); pop — вернуть последний stash; list — показать стек stash.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", description: "push / pop / list (по умолчанию push)" },
            message: { type: "string", description: "Подпись stash (для action: push)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitCherryPick",
        description: "Перенести коммит из другой ветки/истории на текущую ветку (git cherry-pick). commit — хэш или ссылка (например abc123 или HEAD~2).",
        parameters: {
          type: "object",
          properties: { commit: { type: "string", description: "Хэш коммита или ссылка" } },
          required: ["commit"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "gitBlame",
        description: "Показать историю строк файла (git blame): кто и в каком коммите менял каждую строку. path — путь к файлу; lines — сколько первых строк показать (необязательно). Полезно, чтобы понять, когда и зачем появился код.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Путь к файлу" },
            lines: { type: "integer", description: "Сколько первых строк показать (необязательно)" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "semanticSearch",
        description: "Семантический поиск по коду проекта: ищет по смыслу, а не по точному тексту (auth находит authenticate, распознаёт camelCase/snake_case), ранжирует файлы по релевантности и показывает сниппет с номерами строк. query — запрос своими словами (что нужно найти), maxResults — сколько файлов вернуть (по умолчанию 8), path — папка поиска (по умолчанию рабочая). Для точного регулярного поиска используй searchFile/searchProject.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Что ищем своими словами, например «валидация входа», «подключение к базе», «обработка ошибок API»" },
            maxResults: { type: "integer", description: "Сколько файлов вернуть (1–20, по умолчанию 8)" },
            path: { type: "string", description: "Папка поиска (по умолчанию рабочая директория)" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "otaStatus",
        description: "Показать статус локального самообновления (OTA): включено ли, какая версия кода приложения установлена, какие папки-источники бандлов настроены. Вызывай после сборки бандла (node scripts/make-ota.js), чтобы убедиться, что приложение видит обновление.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "otaCheck",
        description: "Проверить и применить локальное OTA-обновление (бандл из папки обновлений). Если обновление найдено — приложение перезапустится с новым кодом. Во время работы агента вернётся busy (применение заблокировано): бандл применится автоматически в течение минуты после завершения задачи.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "otaRollback",
        description: "Откатить код приложения на предыдущую версию (если после обновления что-то сломалось). Приложение перезапустится. Нельзя вызывать во время работы агента.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "ycStatus",
        description: "Yandex Cloud: показать статус подключения (авторизован ли пользователь, какой каталог выбран), разрешения агента на создание/удаление ресурсов и счётчики ресурсов по всем сервисам каталога (API Gateway, Certificates, CDN, DNS, Logging, Postbox, Container Registry, IAM, Lockbox, YDB, Storage, Serverless Containers, VPC).",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "ycList",
        description: "Yandex Cloud: список ресурсов. service — ключ сервиса (apiGateway, certificateManager, cdn, dns, logging, postbox, containerRegistry, iam, lockbox, ydb, storage, serverlessContainers, vpc); без service — сводка по всем. Возвращает имена и id ресурсов.",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "Ключ сервиса (необязательно): apiGateway | certificateManager | cdn | dns | logging | postbox | containerRegistry | iam | lockbox | ydb | storage | serverlessContainers | vpc" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycCreate",
        description: "Yandex Cloud: создать ресурс в выбранном каталоге. service — ключ сервиса (создание доступно для: ydb, lockbox, containerRegistry, storage, dns, serverlessContainers, vpc), name — имя ресурса (латиница, цифры, дефис). Создание может быть платным (YDB, Storage, Containers) — только по явной просьбе пользователя и при включённом разрешении «Разрешить агенту создавать ресурсы».",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "Ключ сервиса: ydb | lockbox | containerRegistry | storage | dns | serverlessContainers | vpc" },
            name: { type: "string", description: "Имя ресурса (2–63 символа, латиница/цифры/дефис)" },
          },
          required: ["service", "name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycDelete",
        description: "Yandex Cloud: удалить ресурс по id (id виден в ycList). service — ключ сервиса, id — идентификатор ресурса. Удаление необратимо и может удалить данные — только по явной просьбе пользователя и при включённом разрешении «Разрешить агенту удалять ресурсы».",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "Ключ сервиса" },
            id: { type: "string", description: "id ресурса (из ycList)" },
          },
          required: ["service", "id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycDeploy",
        description: "Yandex Cloud: задеплоить папку проекта в Serverless Containers (лёгкий хостинг). Собирает Docker-образ (или генерирует Dockerfile по типу проекта), загружает в Container Registry, создаёт/обновляет Serverless Container и при public=true настраивает публичный доступ. directory — папка проекта (по умолчанию рабочая директория), name — имя приложения, public — публичный URL (по умолчанию true). Требует Docker на ПК и разрешение «Разрешить агенту создавать ресурсы». Деплой платный — только по явной просьбе пользователя.",
        parameters: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Папка проекта (по умолчанию рабочая директория)" },
            name: { type: "string", description: "Имя приложения (станет именем контейнера и образа)" },
            public: { type: "boolean", description: "Публичный URL без авторизации (по умолчанию true)" },
            memoryMb: { type: "integer", description: "Память ревизии в МБ (по умолчанию 256)" },
            cores: { type: "integer", description: "Число ядер (по умолчанию 1)" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycLogs",
        description: "Yandex Cloud: показать логи ресурса за последние 3 часа. Читаются внутренним API приложения (Cloud Logging: лог-группы по REST, записи по gRPC) — внешний yc CLI не нужен, ycInstall для логов не требуется. id — id ресурса (из ycList); service — ключ сервиса (необязателен, сужает фильтр по типу ресурса); sinceHours — окно в часах (по умолчанию 3), limit — сколько записей (по умолчанию 100).",
        parameters: {
          type: "object",
          properties: {
            service: { type: "string", description: "Ключ сервиса (необязательно): serverlessContainers | apiGateway | ydb | storage | dns | iam | lockbox | cdn | certificateManager | containerRegistry | logging | vpc" },
            id: { type: "string", description: "id ресурса (из ycList)" },
            sinceHours: { type: "integer", description: "За сколько часов читать (1–168, по умолчанию 3)" },
            limit: { type: "integer", description: "Сколько записей вернуть (1–500, по умолчанию 100)" },
          },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ycInstall",
        description: "Yandex Cloud: установить официальный yc CLI внутрь приложения (папка userData/bin, системных прав не требует) и добавить его в PATH всех команд агента. Нужен, только если в песочнице требуется сама команда yc (логи через ycLogs работают и без него). Токен и каталог подставляются автоматически (YC_IAM_TOKEN — свежий IAM-токен, YC_CLOUD_ID, YC_FOLDER_ID), поэтому yc init не нужен. Если yc ответит «The token is invalid» — повтори вызов через минуту: приложение продлевает IAM само. force=true — переустановить поверх имеющегося.",
        parameters: {
          type: "object",
          properties: {
            force: { type: "boolean", description: "Переустановить, даже если yc CLI уже встроен" },
          },
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
  // Убирает «осиротевшие» tool-сообщения: role:"tool" допустим только сразу после
  // assistant с tool_calls. После обрезки контекста хвост может начинаться с tool
  // (или содержать tool без своего assistant) — такие сообщения ломают
  // OpenAI-совместимые API (400 wrong_api_format «tool must be a response to tool_calls»).
  function sanitizeToolPairs(messages) {
    const out = [];
    let expectTool = false;
    for (const m of messages) {
      if (m && m.role === "tool") {
        if (!expectTool) continue; // сирота — выбрасываем
        out.push(m);
        continue;
      }
      expectTool = false;
      if (m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        expectTool = true;
      }
      out.push(m);
    }
    return out;
  }

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
    if (cutFrom === 0) return sanitizeToolPairs(messages);
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
    // Санитайзер пар assistant(tool_calls)→tool: выкидывает осиротевшие tool-сообщения
    // (в т.ч. одиночный tool, оставшийся после среза цепочки инструментов).
    kept = sanitizeToolPairs(kept);
    if (!kept.length) {
      kept = sanitizeToolPairs(messages.slice(-2));
    }
    if (!kept.length && lastUser >= 0) kept = [messages[lastUser]];
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

  // Усиленный поиск: Google через Serper (нужен API-ключ из настроек).
  // POST https://google.serper.dev/search с заголовком X-API-KEY → { organic: [...] }.
  async function webSearchSerper(query, apiKey) {
    const q = String(query || "").trim();
    if (!q) return "Ошибка: пустой поисковый запрос";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "X-API-KEY": String(apiKey || "").trim(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q: q, num: 10, gl: "ru", hl: "ru" }),
      });
      if (res.status === 401 || res.status === 403) {
        return "Ошибка поиска: Serper отклонил ключ (HTTP " + res.status + "). Проверь ключ в Настройках → 🔒 Секреты.";
      }
      if (!res.ok) return "Ошибка поиска: HTTP " + res.status;
      const data = await res.json();
      const organic = (data && data.organic) || [];
      if (!organic.length) {
        return "Поиск не дал результатов по запросу: " + query + ". Попробуй переформулировать запрос или используй webFetch по известному адресу.";
      }
      return (
        "Результаты поиска по «" + query + "» (Google):\n\n" +
        organic
          .map((r, idx) => (idx + 1) + ". " + (r.title || "—") + "\n   " + (r.link || "") + (r.snippet ? "\n   " + String(r.snippet).slice(0, 300) : ""))
          .join("\n\n") +
        "\n\nЧтобы прочитать страницу целиком, используй инструмент webFetch с её URL."
      );
    } catch (e) {
      return "Ошибка поиска: " + (e && e.name === "AbortError" ? "таймаут" : (e && e.message) || String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  // Классифицирует ошибку провайдера: лечится ли она сменой ключа.
  // key=true только для «ключ/баланс/лимит»: 401/403 (неверный ключ), 402/insufficient
  // (нет баланса/квоты), 429/rate limit (лимит запросов). Ошибки запроса (400),
  // фильтра контента и сети — НЕ про ключ, менять его бессмысленно.
  // cooldownMs — на сколько «отложить» провинившийся ключ, чтобы не долбить провайдера.
  function classifyKeyError(errText) {
    const t = String(errText || "");
    if (/API error 401|API error 403|unauthorized|invalid[_ ]?api[_ ]?key|authentication|неверн\w* ключ/i.test(t)) {
      return { key: true, reason: "auth", cooldownMs: 10 * 60 * 1000 };
    }
    if (/API error 402|insufficient|quota|balance|баланс|недостаточно средств|кончил\w* деньг/i.test(t)) {
      return { key: true, reason: "quota", cooldownMs: 5 * 60 * 1000 };
    }
    if (/API error 429|rate[_ ]?limit|too many requests|per minute|ITPM|TPM|лимит/i.test(t)) {
      return { key: true, reason: "rate", cooldownMs: 60 * 1000 };
    }
    return { key: false, reason: null, cooldownMs: 0 };
  }

  // Веб-поиск: Serper (Google), если задан API-ключ, иначе — DuckDuckGo.
  async function webSearch(query, apiKey) {
    if (String(apiKey || "").trim()) return await webSearchSerper(query, apiKey);
    return await webSearchDDG(query);
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

  // ── План работ (todoWrite): нормализация пунктов ──────────────────────────
  // Принимает что угодно (строки, объекты, JSON-строку) и возвращает чистый
  // список: до 7 пунктов, допустимые статусы, уникальные id. Никогда не бросает.
  const PLAN_STATUSES = ["pending", "in_progress", "done", "failed"];
  const PLAN_MAX_ITEMS = 7;
  const PLAN_STATUS_ALIASES = {
    pending: "pending", todo: "pending", new: "pending", open: "pending", waiting: "pending",
    ожидает: "pending", ожидание: "pending", запланировано: "pending", план: "pending",
    in_progress: "in_progress", inprogress: "in_progress", progress: "in_progress", doing: "in_progress",
    active: "in_progress", current: "in_progress", running: "in_progress",
    в_работе: "in_progress", вработе: "in_progress", работа: "in_progress", выполняется: "in_progress",
    done: "done", complete: "done", completed: "done", ok: "done", success: "done", finished: "done",
    готово: "done", выполнено: "done", сделано: "done", завершено: "done",
    failed: "failed", fail: "failed", error: "failed", blocked: "failed",
    ошибка: "failed", не_удалось: "failed", неудалось: "failed", провал: "failed",
  };

  function normalizePlanStatus(v) {
    const k = String(v == null ? "" : v).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (PLAN_STATUS_ALIASES[k]) return PLAN_STATUS_ALIASES[k];
    return "pending";
  }

  function normalizePlanTasks(raw) {
    let list = raw;
    if (list && !Array.isArray(list) && typeof list === "object") {
      // Модель часто присылает { tasks: [...] } или { items: [...] } целиком.
      list = list.tasks || list.items || list.steps || list.plan || list.todos || null;
    }
    if (typeof list === "string") {
      const t = list.trim();
      try {
        const parsed = JSON.parse(t);
        list = Array.isArray(parsed) ? parsed : (parsed && (parsed.tasks || parsed.items || parsed.steps)) || null;
      } catch {
        // Свободный текст: каждая значимая строка — пункт (снимаем «- », «1. », «[ ]»).
        list = t.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
      }
    }
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const it of list) {
      let text = "";
      let status = "pending";
      let note = "";
      if (it && typeof it === "object") {
        text = String(it.text || it.title || it.task || it.name || it.step || "").trim();
        status = normalizePlanStatus(it.status || it.state || it.done);
        note = String(it.note || it.comment || it.detail || "").trim();
      } else {
        text = String(it == null ? "" : it).trim().replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
      }
      // Строка вида «- [x] шаг» / «☑ шаг» — статус прямо в тексте.
      const cb = text.match(/^\[([ xX\-\/])\]\s*/);
      if (cb) {
        text = text.slice(cb[0].length).trim();
        if (cb[1].toLowerCase() === "x") status = "done";
        else if (cb[1] === "/") status = "in_progress";
      }
      const mark = text.match(/^(✅|✔|☑|❌|⚠️|⚠|🔄|⏳|⬜)\s*/);
      if (mark) {
        text = text.slice(mark[0].length).trim();
        const ch = mark[1];
        if (ch === "✅" || ch === "✔" || ch === "☑") status = "done";
        else if (ch === "❌" || ch === "⚠️" || ch === "⚠") status = "failed";
        else if (ch === "🔄" || ch === "⏳") status = "in_progress";
      }
      // Обрезаем служебное: длинные пункты не нужны, они ломают слабые модели.
      if (text.length > 160) text = text.slice(0, 157).trim() + "…";
      if (note.length > 120) note = note.slice(0, 117).trim() + "…";
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: "t" + (out.length + 1), text, status, note });
      if (out.length >= PLAN_MAX_ITEMS) break;
    }
    // Ровно один шаг может быть «в работе»: если модель пометила несколько
    // (частая ошибка слабых моделей), оставляем первый, остальные понижаем.
    let seenActive = false;
    for (const it of out) {
      if (it.status !== "in_progress") continue;
      if (seenActive) it.status = "pending";
      else seenActive = true;
    }
    return out;
  }

  function planSummary(tasks) {
    const items = Array.isArray(tasks) ? tasks : [];
    const total = items.length;
    const done = items.filter((t) => t && t.status === "done").length;
    const failed = items.filter((t) => t && t.status === "failed").length;
    const active = items.find((t) => t && t.status === "in_progress");
    return { total, done, failed, active: active ? active.text : "" };
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
    shells_status: "shellsStatus",
    shellsstatus: "shellsStatus",
    shell_status: "shellsStatus",
    check_shells: "shellsStatus",
    shells: "shellsStatus",
    browser_open: "browserOpen",
    browser_snapshot: "browserSnapshot",
    browsersnapshot: "browserSnapshot",
    snapshot: "browserSnapshot",
    dom: "browserSnapshot",
    page_map: "browserSnapshot",
    browser_fill: "browserFill",
    browser_click: "browserClick",
    browser_select: "browserSelect",
    browser_press: "browserPress",
    browser_text: "browserText",
    browser_screenshot: "browserScreenshot",
    browser_wait: "browserWait",
    browser_close: "browserClose",
    browser_status: "browserStatus",
    memory_list: "memoryList",
    memorylist: "memoryList",
    memory_days: "memoryList",
    memory_search: "memorySearch",
    memorysearch: "memorySearch",
    context_memory: "memoryList",
    browser_clear_profile: "browserClearProfile",
    browserclearprofile: "browserClearProfile",
    browser_connect: "browserConnect",
    browserconnect: "browserConnect",
    cdp: "browserConnect",
    my_chrome: "browserConnect",
    mychrome: "browserConnect",
    vault_list: "vaultList",
    vaultlist: "vaultList",
    vault_fill: "vaultFill",
    vaultfill: "vaultFill",
    mail_send: "mailSend",
    mailsend: "mailSend",
    send_mail: "mailSend",
    send_email: "mailSend",
    email: "mailSend",
    mail_list: "mailList",
    maillist: "mailList",
    inbox: "mailList",
    list_mail: "mailList",
    mail_code: "mailCode",
    mailcode: "mailCode",
    confirmation_code: "mailCode",
    email_code: "mailCode",
    app_read: "appRead",
    app_click: "appClick",
    app_fill: "appFill",
    app_select: "appSelect",
    app_press: "appPress",
    app_wait: "appWait",
    app_screenshot: "appScreenshot",
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
    git_init: "gitInit",
    gitinit: "gitInit",
    init_repo: "gitInit",
    initrepo: "gitInit",
    create_repo: "gitInit",
    createrepo: "gitInit",
    new_repo: "gitInit",
    local_repo: "gitInit",
    init_git: "gitInit",
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
    todo_write: "todoWrite",
    todowrite: "todoWrite",
    todo: "todoWrite",
    todos: "todoWrite",
    plan: "todoWrite",
    write_plan: "todoWrite",
    writeplan: "todoWrite",
    update_plan: "todoWrite",
    updateplan: "todoWrite",
    plan_tasks: "todoWrite",
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

  // ── Реестр провайдеров G4F (маршрут «Провайдер:модель» в поле модели) ──
  // rec: ★ рекомендованные — стабильные и работающие без ключа/логина.
  // Список один на всех: его же использует транспорт buildChatRequest, чтобы
  // передать провайдера современному g4f отдельным полем provider.
  const G4F_PROVIDERS = [
    { name: "default", desc: "Авто: G4F сам выберет модель и провайдера", rec: true },
    { name: "DeepInfra", desc: "DeepSeek, Qwen, Kimi, GLM — стабильный OpenAI-совместимый API", rec: true , models: ["deepseek-ai/DeepSeek-V3.1","Qwen/Qwen2.5-72B-Instruct","Qwen/Qwen3-32B"] },
    { name: "HuggingChat", desc: "DeepSeek, Qwen, GLM — бесплатный чат Hugging Face", rec: true , models: ["deepseek-ai/DeepSeek-V3","Qwen/Qwen2.5-72B-Instruct","meta-llama/Llama-3.3-70B-Instruct","Qwen/Qwen3-235B-A22B"] },
    { name: "Together", desc: "DeepSeek, Qwen, Llama — быстрый API", rec: true , models: ["deepseek-ai/DeepSeek-V3","Qwen/Qwen2.5-72B-Instruct","meta-llama/Llama-3.3-70B-Instruct"] },
    { name: "Pollinations", desc: "GPT-OSS, DeepSeek, Qwen — бесплатно", rec: true , models: ["openai/gpt-oss-120b","openai/gpt-oss-20b","deepseek/deepseek-v3.1"] },
    { name: "OpenRouterFree", desc: "Бесплатные :free-модели OpenRouter", rec: true , models: ["deepseek/deepseek-r1:free","qwen/qwen3-235b-a22b:free","meta-llama/llama-3.3-70b-instruct:free"] },
    { name: "Groq", desc: "Очень быстрые Llama / DeepSeek", rec: true , models: ["llama-3.3-70b-versatile","deepseek-r1-distill-llama-70b","llama-3.1-8b-instant"] },
    { name: "Airforce", desc: "gpt-oss, kimi-k3, glm-5.3 — огромный каталог", rec: true , models: ["gpt-oss-120b","gpt-4o","kimi-k2","glm-4.5"] },
    { name: "HuggingFace", desc: "Inference API Hugging Face" , models: ["Qwen/Qwen2.5-72B-Instruct","meta-llama/Llama-3.3-70B-Instruct"] },
    { name: "HuggingSpace", desc: "Модели с HF Spaces: Command R, Qwen" , models: ["CohereForAI/c4ai-command-r-plus","Qwen/Qwen2.5-72B-Instruct"] },
    { name: "OpenRouter", desc: "1000+ моделей (многие с суффиксом :free)" , models: ["openai/gpt-4o-mini","anthropic/claude-3.5-sonnet","deepseek/deepseek-chat"] },
    { name: "Yqcloud", desc: "gpt-4 — работает без всего" , models: ["gpt-4"] },
    { name: "KiloCode", desc: "Nemotron, MiniMax — для кода" , models: ["nvidia/Llama-3.1-Nemotron-70B-Instruct","minimax/MiniMax-M2"] },
    { name: "ThebApi", desc: "Агрегатор TheB.AI" , models: ["gpt-4o","claude-3.5-sonnet","deepseek-chat"] },
    { name: "Perplexity", desc: "Claude Opus / Sonnet через поиск (может просить вход)" , models: ["sonar-pro","sonar"] },
    { name: "Copilot", desc: "Microsoft Copilot — GPT-4o, o1" , models: ["gpt-4o","o1"] },
    { name: "OpenaiChat", desc: "ChatGPT бесплатно — gpt-4.1, o3" , models: ["gpt-4.1","gpt-4o-mini","o3-mini"] },
    { name: "Gemini", desc: "Google Gemini 2.5/3 (иногда нужны куки)" , models: ["gemini-2.5-flash","gemini-2.0-flash"] },
    { name: "Antigravity", desc: "Google Antigravity — Gemini + Claude" , models: ["gemini-2.5-flash","claude-3.5-sonnet"] },
    { name: "Qwen", desc: "Модели Qwen напрямую" , models: ["qwen-max","qwen-plus","qwen-turbo"] },
    { name: "DeepSeek", desc: "chat.deepseek.com — нужен HAR-логин" , models: ["deepseek-chat","deepseek-reasoner"] },
    { name: "Claude", desc: "Anthropic Claude (обычно нужен ключ или аккаунт)" , models: ["claude-3-5-sonnet"] },
    { name: "Anthropic", desc: "Официальный API Anthropic" , models: ["claude-sonnet-4-5","claude-opus-4-1","claude-haiku-4-5"] },
    { name: "Grok", desc: "xAI Grok — рассуждения и код" , models: ["grok-3","grok-3-mini"] },
    { name: "xAI", desc: "API xAI" , models: ["grok-3","grok-3-mini"] },
    { name: "Nvidia", desc: "NVIDIA NIM — opensource-модели" , models: ["meta/llama-3.3-70b-instruct","deepseek-ai/deepseek-r1"] },
    { name: "Cerebras", desc: "Очень быстрые Llama / Qwen" , models: ["llama-3.3-70b","llama-3.1-8b"] },
    { name: "MiniMax", desc: "MiniMax M — сильный кодер" , models: ["MiniMax-M1-80k","MiniMax-M2"] },
    { name: "GlhfChat", desc: "Модели Hugging Face через glhf.chat" , models: ["Qwen/Qwen3-235B-A22B","deepseek-ai/DeepSeek-R1"] },
    { name: "LMArena", desc: "Публичные модели LMArena" , models: ["llama-3.3-70b"] },
    { name: "MetaAI", desc: "Llama через Meta AI" , models: ["llama-3.3-70b-instruct"] },
    { name: "Puter", desc: "Llama бесплатно" , models: ["llama-3.3-70b-instruct"] },
    { name: "GigaChat", desc: "Сбер GigaChat" , models: ["GigaChat-Pro","GigaChat-Max"] },
    { name: "Replicate", desc: "Open-source модели через Replicate" , models: ["meta/meta-llama-3-70b-instruct"] },
    { name: "PhindAi", desc: "Phind — специалист по коду" , models: ["Phind-V2","Phind-V2-75B"] },
    { name: "Cloudflare", desc: "Workers AI Cloudflare" , models: ["@cf/meta/llama-3.1-8b-instruct"] },
    { name: "OperaAria", desc: "Opera Aria — GPT-4o" , models: ["gpt-4o"] },
    { name: "WhiteRabbitNeo", desc: "WhiteRabbit Neo — безопасный кодер" , models: ["WhiteRabbitNeo-33B"] },
    { name: "BlackboxPro", desc: "Blackbox AI — GPT, Claude" , models: ["blackboxai-3.5"] },
    { name: "OrcaRouter", desc: "Роутер моделей (как OpenRouter)" , models: ["qwen3-max"] },
    { name: "HailuoAI", desc: "MiniMax Hailuo" , models: ["MiniMax-M1"] },
  ];
  const G4F_PROVIDER_NAMES = new Set(G4F_PROVIDERS.map((p) => p.name));

  // G4F-маршрут «Провайдер:модель» (например HuggingChat:gpt-4o-mini).
  // Возвращает { provider, model } только если префикс — известный провайдер G4F
  // (иначе не трогаем имя: у OpenRouter и других бывают свои двоеточия, например :free).
  function splitG4fRoute(model) {
    const m = String(model || "");
    const i = m.indexOf(":");
    if (i <= 0 || i === m.length - 1) return null;
    const prefix = m.slice(0, i);
    if (!G4F_PROVIDER_NAMES.has(prefix)) return null;
    return { provider: prefix, model: m.slice(i + 1) };
  }

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

  // Веб-предпросмотр: Yandex AI Studio не отдаёт CORS-заголовки — браузер блокирует
  // прямые запросы («Failed to fetch»). В браузерном режиме база переписывается на
  // локальный прокси preview-сервера (/api/llm/...), который ходит в Яндекс сам.
  // Веб-предпросмотр: Yandex AI Studio и Ollama Cloud не отдают CORS-заголовки —
  // браузер блокирует прямые запросы («Failed to fetch»). В браузерном режиме база
  // переписывается на локальный прокси preview-сервера (/api/llm/...), который ходит
  // к провайдеру сам (server.js разрешает внешние https, внутренние сети — 403).
  function proxiedBase(base) {
    const b = String(base || "");
    const local =
      /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;
    if (
      typeof location !== "undefined" && location && location.origin &&
      /^https:\/\//i.test(b) && !local.test(b)
    ) {
      return location.origin + "/api/llm/" + encodeURIComponent(b);
    }
    return b;
  }

  function apiKeyFor(provider, s) {
    if (provider === "anthropic") return s.anthropicApiKey || s.apiKey || "";
    if (provider === "openai") return s.openaiApiKey || s.apiKey || "";
    return "";
  }

  function apiHeaders(provider, apiKey, fromBrowser, extra) {
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
    if (extra && typeof extra === "object") Object.assign(h, extra);
    return h;
  }

  // Yandex AI Studio (OpenAI-совместимый эндпоинт): каталог (папка) передаётся заголовком OpenAI-Project.
  function projectHeader(s) {
    const f = s && s.openaiProject ? String(s.openaiProject).trim() : "";
    return f ? { "OpenAI-Project": f } : null;
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
    const headers = apiHeaders(provider, apiKey, fromBrowser, projectHeader(s));

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
    // G4F-маршрут «Провайдер:модель» (например HuggingChat:gpt-4o-mini):
    // современный g4f принимает провайдера отдельным полем provider, а имя модели — без префикса.
    const body = { model, messages: messagesForProvider("openai", messages), tools, stream: true };
    const g4f = splitG4fRoute(model);
    if (g4f) {
      body.model = g4f.model;
      body.provider = g4f.provider;
    }
    return {
      url: proxiedBase(baseFor(provider, s)) + "/chat/completions",
      headers,
      body: JSON.stringify(body),
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
  // ── Чтение стрима ответа провайдера с защитой от «вечного ожидания» ──
  // 1) Ошибки, которые провайдеры шлют прямо в стриме (data: {"error": ...} —
  //    OpenAI-совместимые, {"type":"error"} — Anthropic, NDJSON-ошибки Ollama),
  //    превращаются в исключение с понятным текстом, а не молча пропускаются
  //    (раньше это выглядело как «бесконечное думание»).
  // 2) Таймауты: первый байт (firstByteTimeoutMs, по умолчанию 90 с) и пауза
  //    между чанками (idleTimeoutMs, по умолчанию 60 с) — зависший/молчащий
  //    провайдер завершается ошибкой вместо бесконечного ожидания.
  async function consumeProviderStream({ response, provider, onText, onToolCall, onThinking, firstByteTimeoutMs, idleTimeoutMs }) {
    if (!response || !response.body) throw new Error("Пустой ответ от сервера (нет тела).");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Аккумуляция по индексу блока (OpenAI: tool_calls по index; Anthropic: content_block по index)
    const accum = new Map();
    const seenOllamaCalls = new Set();
    // Gemini 3.x: шифрованная подпись мысли (thought signature) приходит в
    // extra_content.google.thought_signature — на самом tool-call или отдельной дельтой.
    // Её нужно вернуть модели дословно в следующем запросе, иначе API отвечает 400
    // «Function call is missing a thought_signature in functionCall parts».
    let pendingExtra = null;
    const finalizeAccum = () => {
      for (const item of accum.values()) {
        if (!item.name) continue;
        const call = { id: item.id || genCallId(), name: item.name, args: jsonArgs(item.args) };
        if (item.extra) call.extraContent = item.extra;
        if (onToolCall) onToolCall(call);
      }
      accum.clear();
      pendingExtra = null;
    };
    const firstMs = firstByteTimeoutMs || 90000;
    const idleMs = idleTimeoutMs || 60000;
    let gotFirst = false;
    // reader.read() с таймером: зависший стрим не держит чат в «думании» вечно.
    const readChunk = () =>
      new Promise((resolve, reject) => {
        const ms = gotFirst ? idleMs : firstMs;
        const timer = setTimeout(() => {
          reader.cancel().catch(() => {});
          reject(
            new Error(
              gotFirst
                ? "Провайдер замолчал — данные не приходили более " + Math.round(ms / 1000) + " с. Проверь сеть или выбери другого провайдера."
                : "Провайдер не отвечает — первый байт не пришёл за " + Math.round(ms / 1000) + " с. Проверь, что сервер запущен и URL в настройках верный."
            )
          );
        }, ms);
        reader.read().then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          }
        );
      });
    const errText = (e) => {
      if (!e) return "";
      if (typeof e === "string") return e;
      return e.message || e.detail || e.code || JSON.stringify(e).slice(0, 300);
    };
    try {
      while (true) {
        const { done, value } = await readChunk();
        if (done) break;
        // «Первый байт» засчитываем только при реальных данных: провайдер, который шлёт
        // пустые keep-alive чанки, но так и не отвечает, тоже завершится по таймауту.
        if (value && value.length) gotFirst = true;
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
            if (obj && obj.error) throw new Error("Ошибка Ollama: " + errText(obj.error));
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
            // Ошибка внутри стрима (частая беда бесплатных провайдеров G4F:
            // «Зарегистрируйтесь и повторите свой запрос» и т.п.) — показываем её,
            // а не ждём вечно молчания.
            if (obj.error || (obj.type === "error" && obj.error)) {
              throw new Error("Провайдер ответил ошибкой: " + (errText(obj.error) || errText(obj)));
            }
            const choice = obj.choices && obj.choices[0];
            if (!choice) continue;
            const delta = choice.delta || {};
            if (delta.content && onText) onText(delta.content);
            // DeepSeek и другие OpenAI-совместимые шлют рассуждения отдельным полем
            if (delta.reasoning_content && onThinking) onThinking(delta.reasoning_content);
            // Gemini может прислать подпись мысли отдельным полем delta.extra_content
            // (до или вместо поля на самом tool-call) — запоминаем и подставляем вызовам без своей.
            if (delta.extra_content && delta.extra_content.google && delta.extra_content.google.thought_signature) {
              pendingExtra = delta.extra_content;
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const i = tc.index || 0;
                const cur = accum.get(i) || { id: "", name: "", args: "", extra: null };
                if (tc.id) cur.id = tc.id;
                const fn = tc.function || {};
                if (fn.name) cur.name = fn.name;
                if (fn.arguments) cur.args += fn.arguments;
                if (tc.extra_content && tc.extra_content.google && tc.extra_content.google.thought_signature) {
                  cur.extra = tc.extra_content;
                } else if (pendingExtra && !cur.extra) {
                  cur.extra = pendingExtra;
                }
                accum.set(i, cur);
              }
              pendingExtra = null;
            }
          } else if (provider === "anthropic") {
            const type = obj.type;
            if (type === "error" && obj.error) {
              throw new Error("Claude ответил ошибкой: " + errText(obj.error));
            }
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
    const headers = apiHeaders(provider, apiKey, fromBrowser, projectHeader(s));

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
    const res = await fetch(proxiedBase(baseFor(provider, s)) + "/models", { headers, signal: timeout });
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

  // Понятное объяснение лимитных ошибок провайдеров вместо сырого JSON.
  // Groq free: ~7K входных токенов/мин (ITPM) для всех моделей, а системный
  // промпт + схемы инструментов агента весят десятки тысяч токенов — обрезка
  // истории не поможет, нужен другой провайдер или платный тир.
  function friendlyRateLimitError(status, detail, settings) {
    const s = settings || {};
    const base = String(s.openaiUrl || s.externalUrl || "");
    const isGroq = /groq\.com/i.test(base);
    const d = String(detail || "");
    const isTokenMinute =
      /per minute|tokens per minute|ITPM|rate_limit_exceeded|reduce your message size/i.test(d);
    if (isGroq && (status === 413 || status === 429) && isTokenMinute) {
      return (
        "API error " + status + ": Groq (бесплатный тариф) ограничивает входные токены ~7 000/мин, "
        + "а запрос агента (системный промпт + схемы инструментов + контекст) весит десятки тысяч "
        + "токенов — лимит исчерпывается ещё до ответа, и обрезка истории здесь не поможет.\n\n"
        + "Как продолжить:\n"
        + "1) переключись в Настройках → «🌐 OpenAI-совместимые» на чип Ollama Cloud (gpt-oss:120b), "
        + "Yandex (DeepSeek V4 Flash) или Cerebras — они уже настроены и без этого лимита;\n"
        + "2) либо включи Groq Dev Tier (console.groq.com/settings/billing) — лимит вырастет.\n"
        + "Бесплатный Groq подходит только для коротких сообщений без инструментов."
      );
    }
    return null;
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
      project: (s.openaiProject || "").trim(),
    };
  }

  // Чтение изображения vision-моделью: dataUrl → текстовое описание.
  async function describeImageRemote(cfg, imageDataUrl, prompt, model) {
    const res = await fetch(proxiedBase(cfg.url) + "/chat/completions", {
      method: "POST",
      headers: apiHeaders("openai", cfg.key, false, cfg.project ? { "OpenAI-Project": cfg.project } : null),
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
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(180000) : undefined,
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
    const res = await fetch(proxiedBase(cfg.url) + "/images", {
      method: "POST",
      headers: apiHeaders("openai", cfg.key, false, cfg.project ? { "OpenAI-Project": cfg.project } : null),
      body: JSON.stringify(body),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(300000) : undefined,
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

  // ── Динамические инструменты: при тесном контексте шлём только ядро ──
  const CORE_TOOL_NAMES = new Set([
    "createFolder", "readFile", "writeFile", "listDirectory", "readFileLines", "editFile",
    "runCommand", "runCommandOutput", "retryCommand", "timeoutCommand", "shellsStatus",
    "webSearch", "webFetch", "searchFile", "searchProject", "listFiles",
    "fileOutline", "readFileStructure", "explainCode", "undoEdit",
    "startBackground", "listBackground", "backgroundOutput", "sendInput", "stopBackground",
    "shellStart", "shellSend", "checkUrl", "checkPort", "openUrl", "showImage",
    "previewUI", "diffView", "askUser", "analyzeImage", "generateImage", "screenshotCapture",
    "listProcesses", "killProcess", "clipboardRead", "clipboardWrite", "screenshotDesktop",
    "registryRead", "registryWrite", "openPath", "wingetSearch", "installExe",
    "memoryList", "memorySearch", "todoWrite",
  ]);
  const CORE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((t) => CORE_TOOL_NAMES.has(t.function && t.function.name));
  // Если окно контекста >= 26k — шлём все инструменты; иначе только ядро (~36 вместо 74).
  function selectTools(budget) {
    const b = budget || contextBudget("openai");
    return b >= 26000 ? TOOL_DEFINITIONS : CORE_TOOL_DEFINITIONS;
  }

  // ── Реальное окно модели (context_length / context_window из GET /models) ──
  const _ctxModelsCache = new Map(); // base → { ts, byModel: Map<model, window> }
  const _CTX_TTL = 10 * 60 * 1000;
  async function modelWindow(s, model) {
    const provider = s && s.provider ? s.provider : "openai";
    if (provider !== "openai" || !model) return 0;
    const base = baseFor(provider, s);
    const now = Date.now();
    let entry = _ctxModelsCache.get(base);
    if (!entry || now - entry.ts > _CTX_TTL) {
      let fetched = null;
      try {
        const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
        const res = await fetch(proxiedBase(base) + "/models", {
          headers: apiHeaders(provider, apiKeyFor(provider, s), false, projectHeader(s)),
          signal: timeout,
        });
        if (res.ok) {
          const d = await res.json();
          const byModel = new Map();
          for (const m of d.data || []) {
            const id = m && m.id ? String(m.id) : "";
            const win = (m && (m.context_length || m.context_window)) || 0;
            if (id && win > 0) byModel.set(id, win);
          }
          fetched = { ts: now, byModel };
        }
      } catch {}
      entry = fetched || { ts: now, byModel: new Map() };
      _ctxModelsCache.set(base, entry);
    }
    if (!entry) return 0;
    if (entry.byModel.has(model)) return entry.byModel.get(model);
    // Суффиксные варианты id: "vendor/model:free", "vendor/model@date", "vendor/model-vN"
    for (const [id, win] of entry.byModel) {
      if (id.startsWith(model + ":") || id.startsWith(model + "@") || id.startsWith(model + "-")) return win;
    }
    return 0;
  }

  // ── Компакция: старые витки диалога сжимаются в памятку дешёвым вызовом модели ──
  async function compactRemote(s, messages) {
    try {
      const provider = s && s.provider ? s.provider : "openai";
      const model = (s && s.model) || "";
      if (!model) return null;
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === "user") {
          lastUser = i;
          break;
        }
      }
      if (lastUser <= 0) return null; // нечего сжимать — только текущий виток
      const head = messages.slice(0, lastUser);
      let headTokens = 0;
      for (const m of head) headTokens += estimateMessageTokens(m);
      if (headTokens < 4000) return null; // голова маленькая — обычная обрезка дешевле вызова
      const parts = [];
      for (const m of head) {
        const role = m && m.role;
        const label = role === "user" ? "Пользователь" : role === "assistant" ? "Агент" : role === "system" ? "Система" : "Инструмент";
        const c = m && m.content;
        let txt = "";
        if (typeof c === "string") txt = c;
        else if (Array.isArray(c)) txt = partsText(c) || "[изображение]";
        if (String(txt || "").trim()) parts.push(label + ": " + truncateText(txt, 1200));
      }
      const body = parts.join("\n\n").slice(0, 30000);
      if (!body.trim()) return null;
      const sys =
        "Ты — менеджер памяти ИИ-агента-разработчика. Сожми переписку в краткую памятку на русском (до 700 слов): что просил пользователь, что уже сделано (файлы, команды, git), текущее состояние проекта, что осталось сделать. Памятка должна позволить агенту продолжить работу без исходных сообщений. Пиши только саму памятку, без пояснений.";
      const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined;
      const headers = apiHeaders(provider, apiKeyFor(provider, s), false, projectHeader(s));
      if (provider === "anthropic") {
        const res = await fetch(baseFor(provider, s) + "/v1/messages", {
          method: "POST",
          headers,
          signal: timeout,
          body: JSON.stringify({ model, max_tokens: 900, system: sys, messages: [{ role: "user", content: body }], stream: false }),
        });
        if (!res.ok) return null;
        const d = await res.json();
        return (d.content || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n") || null;
      }
      if (provider === "ollama") {
        const res = await fetch(baseFor(provider, s) + "/api/chat", {
          method: "POST",
          headers,
          signal: timeout,
          body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: body }], stream: false }),
        });
        if (!res.ok) return null;
        const d = await res.json();
        return (d.message && d.message.content) || null;
      }
      const res = await fetch(proxiedBase(baseFor(provider, s)) + "/chat/completions", {
        method: "POST",
        headers,
        signal: timeout,
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: body }], max_tokens: 900, stream: false }),
      });
      if (!res.ok) return null;
      const d = await res.json();
      return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || null;
    } catch {
      return null;
    }
  }

  // Фабрика менеджера контекста: компакция (один раз за запуск) + обрезка хвоста.
  function createContextManager(opts) {
    const settings = (opts && opts.settings) || {};
    const emit = (opts && opts.emit) || (() => {});
    const planMode = !!(opts && opts.planMode);
    // onMemo — необязательный хук: получает текст только что созданной памятки и
    // сообщения, из которых она свёрнута. main.js пишет по нему локальный дневник
    // (память диалогов по датам). Ошибка хука не должна ломать работу агента.
    const onMemo = (opts && opts.onMemo) || null;
    let compacted = false;
    let compactMemo = null;
    return {
      async manage(messages, budget) {
        if (!Array.isArray(messages) || !messages.length) return messages || [];
        const memoWeight = compactMemo ? estimateTokens(compactMemo.content) : 0;
        let total = 0;
        for (const m of messages) total += estimateMessageTokens(m);
        // Страховка: даже если обрезка не нужна, убираем осиротевшие tool-сообщения
        // (role:"tool" без предшествующего assistant с tool_calls ломает API — 400 wrong_api_format).
        if (total + memoWeight <= budget) {
          return compactMemo ? [compactMemo, ...sanitizeToolPairs(messages)] : sanitizeToolPairs(messages);
        }
        if (!compacted && !planMode) {
          compacted = true;
          try {
            const memoText = await compactRemote(settings, messages);
            if (memoText && String(memoText).trim()) {
              compactMemo = {
                role: "system",
                content:
                  "ПАМЯТКА ПРЕДЫДУЩЕГО КОНТЕКСТА (сжато, чтобы экономить токены; это резюме старых шагов):\n" +
                  String(memoText).trim(),
              };
              if (onMemo) {
                try {
                  onMemo({
                    text: String(memoText).trim(),
                    messages,
                    provider: settings.provider || "",
                    model: settings.model || "",
                    ts: Date.now(),
                  });
                } catch {}
              }
              if (emit) emit({ type: "compact", text: "🧠 Контекст сжат: старые шаги свернуты в памятку — токены экономятся." });
            }
          } catch {}
        }
        const rest = trimConversation(messages, Math.max(1500, budget - memoWeight - 400));
        return compactMemo ? [compactMemo, ...rest] : rest;
      },
      memo() {
        return compactMemo;
      },
    };
  }

  // ── Парсеры для инструментов ОС (процессы, реестр, системная информация) ──
  // tasklist /FO CSV /NH (Windows) или ps -eo (macOS/Linux) → [{pid, name, mem, ...}]
  function parseProcessesCsv(csv) {
    const procs = [];
    const lines = String(csv || "").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/"([^"]*)","(\d+)","([^"]*)","([^"]*)","([^"]*)"/);
      if (m) {
        procs.push({ name: m[1], pid: parseInt(m[2], 10), session: m[3], sessionNum: m[4], mem: m[5] });
        continue;
      }
      const p = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
      if (p) procs.push({ pid: parseInt(p[1], 10), name: p[2], cpu: p[3], rss: p[4], args: p[5] });
    }
    return procs;
  }

  // Whitelist реестра: чтение — только SOFTWARE/ENVIRONMENT/SYSTEM/SECURITY; запись — только HKCU.
  function registryPathAllowed(regPath, write) {
    const p = String(regPath || "").trim();
    if (!p) return { ok: false, error: "Укажи путь в реестре (например HKCU\\Software\\MyApp)" };
    if (!/^HK[A-Z0-9]+\\/i.test(p)) {
      return { ok: false, error: "Путь должен начинаться с корня (HKLM\\, HKCU\\, HKCR\\, HKU\\ или HKCC\\)" };
    }
    const up = p.toUpperCase();
    if (write) {
      const ok = up.startsWith("HKCU\\SOFTWARE") || up.startsWith("HKCU\\ENVIRONMENT");
      return ok
        ? { ok: true }
        : { ok: false, error: "Запись разрешена только в HKCU\\Software и HKCU\\Environment. Для HKLM нужны права администратора — используй runCommandAsAdmin с reg add." };
    }
    const first = (up.split("\\")[1] || "").toUpperCase();
    if (["SOFTWARE", "ENVIRONMENT", "SYSTEM", "SECURITY"].includes(first)) return { ok: true };
    return { ok: false, error: "Чтение разрешено только из разделов SOFTWARE, ENVIRONMENT, SYSTEM, SECURITY (например HKLM\\Software, HKCU\\Environment)." };
  }

  // Разбор JSON системной информации от PowerShell → плоский объект.
  function parseSysInfoJson(json) {
    const d = {};
    try {
      const o = JSON.parse(String(json || "{}"));
      if (o && typeof o === "object") {
        if (o.os) d.os = String(o.os);
        if (o.build) d.build = String(o.build);
        if (o.cpu) d.cpu = String(o.cpu);
        if (o.gpu) d.gpu = String(o.gpu);
        if (o.ramGB != null) d.ramGB = Number(o.ramGB);
        if (Array.isArray(o.ips)) d.ips = o.ips.map(String);
        if (Array.isArray(o.disks)) d.disks = o.disks;
      }
    } catch {}
    return d;
  }

  return {
    SYSTEM_PROMPT,
    TOOL_DEFINITIONS,
    G4F_PROVIDERS,
    createThinkingStripper,
    stripThinking,
    normalizeToolName,
    normalizeToolArgs,
    normalizePlanTasks,
    normalizePlanStatus,
    planSummary,
    PLAN_MAX_ITEMS,
    extractToolCallsFromText,
    // транспорт провайдеров
    buildChatRequest,
    consumeProviderStream,
    listModels,
    readApiError,
    friendlyRateLimitError,
    genCallId,
    // контекст
    estimateTokens,
    estimateMessageTokens,
    contextBudget,
    trimConversation,
    sanitizeToolPairs,
    truncateText,
    selectTools,
    modelWindow,
    compactRemote,
    createContextManager,
    // веб (общий для Electron main и preview-сервера)
    downloadHtml,
    webSearchDDG,
    webSearch,
    classifyKeyError,
    webFetchPage,
    htmlToText,
    // вспомогательная модель: зрение + генерация изображений
    auxConfig,
    describeImageRemote,
    generateImageRemote,
    // инструменты ОС
    parseProcessesCsv,
    registryPathAllowed,
    parseSysInfoJson,
  };
});
