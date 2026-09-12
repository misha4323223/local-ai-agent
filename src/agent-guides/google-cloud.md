# Google Cloud Console: как пройти типовые задачи

<!-- sites: console.cloud.google.com, cloud.google.com, console.developers.google.com -->

Этот справочник читай ПЕРЕД действиями: почти все «стены» в консоли Google Cloud —
это три экрана (проект, включение API, ключи), и проходятся они в одном порядке.
Сессия живёт в браузере агента: если пользователь уже вошёл, вход не потребуется.

## 0. Проверка перед работой (30 секунд)
1. `browserOpen { url: "https://console.cloud.google.com/" }`.
2. `browserOverlays { dismiss: true }` — убрать баннер «Перевести страницу?» (он сдвигает
   страницу и перехватывает клики).
3. `waitForIdle` — консоль Angular, первые секунды она активно перерисовывается.
4. `browserSnapshot { filter: "проект" }` — посмотреть, есть ли выбранный проект.
   В шапке сверху есть селектор проекта: «Google Cloud» слева, рядом название проекта.
   Если написано «No project selected» — идём в п.1.

## 1. Проект (нужен для API-ключа и любых ресурсов)
- Клик по селектору проекта в шапке (обычно это кнопка с текущим проектом или
  «Select a project»), откроется диалог выбора.
- В диалоге: «NEW PROJECT» / «Создать проект» (кнопка вверху справа).
- Поля: «Project name» (имя), «Location» (оставь «No organization»). Жми «CREATE»/«Создать».
- Уведомление о создании приходит «колокольчиком» — не жди его, просто `waitForIdle`,
  затем переоткрой селектор проекта и выбери созданный.
- ⚠️ Создание проекта занимает 5–20 секунд; кнопка «CREATE» может остаться неактивной,
  пока не заполнится имя. Если проект «не создаётся» — проверь уведомления
  (значок 🔔 справа сверху): там будет точная причина (лимит проектов, аккаунт Starter).

## 2. Диалоги-«стены» (главный источник блужданий)
- **Welcome / Terms of Service** («I agree to the Google Cloud Platform Terms of Service…»):
  это слой поверх страницы. В карте он идёт ПЕРВЫМ с пометкой «в диалоге».
  Чекбокс согласия бывает ПРОЗРАЧНЫМ (`opacity: 0`) — в карте он помечен
  «скрытый ввод — клик с force». Порядок: `browserClick` по чекбоксу → `browserClick`
  по «Agree and continue» / «Продолжить». Кнопка станет активной только после галочки.
- Если клик не проходит: `browserEval { script: "document.querySelector('.cdk-overlay-container input[type=checkbox]').click()" }`,
  затем клик по кнопке подтверждения (`browserClick { name: "Agree and continue" }`).
- ⚠️ Юридические согласия молча не подтверждай: этот экран проходят только по просьбе
  пользователя (он сам должен быть согласен с условиями).
- Другие помехи: баннер cookie (кнопка «Reject all»/«Отклонить все»), панель «Что нового»,
  подсказки-тур с кнопкой «Got it»/«Понятно» — `browserOverlays { dismiss: true }`.

## 3. Включение API (Gemini API, Vertex AI, Compute и т.д.)
Маршрут: `https://console.cloud.google.com/apis/library`.
1. В поле поиска «Search for APIs & Services» введи имя API (например `Gemini`).
   Не скролль список — ищи через поле.
2. В результатах клик по нужной карточке (например «Gemini API» → Generative Language API).
3. На странице API — кнопка **ENABLE** / **ВКЛЮЧИТЬ**. После включения она сменяется на «MANAGE»/«УПРАВЛЕНИЕ».
4. ⚠️ Над результатами может висеть строка «API selection required» — это просьба выбрать
   проект. Возврат в п.1: выбери проект, потом повтори поиск.
5. ⚠️ После ENABLE страница обновляется 5–30 секунд, кнопка «дёргается». `waitForIdle`,
   затем `browserText` (или скриншот) — убедись, что статус «Enabled», а не «Enable» снова.

## 4. API-ключ (Gemini API / Maps / Translate)
Маршрут: `https://console.cloud.google.com/apis/credentials`
1. Сверху — «+ CREATE CREDENTIALS» / «СОЗДАТЬ УЧЁТНЫЕ ДАННЫЕ» → выпадающее меню →
   «API key» / «Ключ API».
2. ⚠️ Это Material-меню, НЕ `<select>`: клик по кнопке `browserClick { name: "CREATE CREDENTIALS" }`,
   `waitForIdle`, затем клик по «API key» (пункт появляется отдельным слоем в карте).
3. Откроется диалог «API key created» с ключом и кнопкой «COPY»/«Copy to clipboard».
   Читай ключ через `browserEval`: набери текст диалога
   (`browserText` покажет его целиком) — ключ виден в тексте страницы.
4. Ключ — секрет: не выводи его в чат целиком и не сохраняй в файлы проекта с кодом.
   Он должен попасть в настройки приложения/в переменную окружения.
5. Ограничения (по желанию): «Edit API key» → «API restrictions» → «Restrict key» →
   выбрать API. После правок «SAVE» — не забудь прокрутить диалог вниз.

## 5. OAuth client ID (вход через Google) — если нужен
`apis/credentials` → «CREATE CREDENTIALS» → «OAuth client ID». Перед первым разом
требуется «Configure consent screen» (OAuth consent screen): тип «External», название,
support email, сохранить. ⚠️ Дальше несколько экранов с «SAVE AND CONTINUE» —
проходи их подряд, кнопка всегда справа внизу (прокрути `browserScroll { how: "bottom" }`).

## 6. Что видеть, а не угадывать
- «Квота/биллинг»: `console.cloud.google.com/billing` — если проект Starter/без биллинга,
  часть API не включится, и об этом скажет красная плашка в шапке страницы API.
- Уведомления/ошибки операций: значок 🔔 в шапке (диалог «Notifications»).
- Активити: `console.cloud.google.com/home/activity` — кто/что менял (и был ли создан ресурс).
- Если действие «не сработало»: `browserNetwork {}` покажет, ушёл ли запрос к API Google
  и что он ответил (обычно 403 с внятной причиной) — это быстрее, чем щёлкать наугад.

## 7. Сокращай путь
- Прямые адреса вместо меню: `/apis/library`, `/apis/credentials`, `/home/dashboard`,
  `/billing`, `/iam-admin/serviceaccounts`, `/compute/instances` (Compute Engine),
  `/sql` (Cloud SQL), `/storage/browser` (Buckets), `/logs` (Logging).
- Навигация консоли «плавает» (меню меняют), а адреса — нет: открывай адрес
  `browserAct { steps: [{ goto: "https://console.cloud.google.com/apis/credentials" }, { wait: 1500 }, { snapshot: true }] }`
  — это один вызов вместо пяти кликов по меню.
