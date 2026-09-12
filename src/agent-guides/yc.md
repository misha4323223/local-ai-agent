# Yandex Cloud (yc-инструменты)

Справочник агента. Читается вручную: `agentGuide { name: "yc" }` (или `readFile { path: "agent-guide:yc" }`).
Подключается автоматически, когда в задаче появляется облако (группа `cloud`).

## Порядок работы

1. `ycStatus` — ВСЕГДА начинай отсюда: авторизован ли пользователь (Настройки → «☁️ Yandex Cloud»),
   какой каталог выбран, какие разрешения выданы агенту, счётчики ресурсов по всем сервисам.
2. `ycList` — список ресурсов. `service` — ключ сервиса; без `service` — сводка по всем.
   Возвращает имена и `id`. Результат любой операции проверяй `ycList`, а не по памяти.
3. Создание/удаление/деплой — только по ЯВНОЙ просьбе пользователя и при включённых чекбоксах
   разрешений: ресурсы платные, удаление необратимо.

## Инструменты

- `ycCreate { service, name }` — создание ресурса в выбранном каталоге. `name` — латиница, цифры, дефис.
  Создание доступно для: `ydb`, `lockbox`, `containerRegistry`, `storage`, `dns`, `serverlessContainers`, `vpc`.
- `ycDelete { service, id }` — удаление по `id` (виден в `ycList`). Необратимо и может удалить данные.
- `ycDeploy { directory, name, public }` — деплой папки проекта в Serverless Containers: собирает Docker-образ
  (или генерирует Dockerfile по типу проекта), загружает в Container Registry, создаёт/обновляет
  Serverless Container, при `public: true` настраивает публичный доступ → возвращает URL.
  Требует Docker на ПК и разрешение на создание ресурсов. Деплой платный.
- `ycLogs { id, service, sinceHours, limit }` — логи ресурса за последние 3 часа (окно и лимит настраиваются).
  Читаются ВНУТРЕННИМ API приложения (Cloud Logging: лог-группы по REST, записи по gRPC с хоста `log-reading`) —
  внешний `yc` CLI для логов НЕ нужен, `ycInstall` не требуется.
- `ycInstall { force }` — официальный `yc` CLI внутрь папки приложения (`userData/bin`, системных прав не требует)
  и в PATH всех команд агента. Нужен, только если в песочнице требуется сама команда `yc`.
  Если `yc` ответит «The token is invalid» — повтори вызов через минуту: приложение продлевает IAM само.

## Токен и каталог

Подставляются автоматически: `YC_IAM_TOKEN` (свежий IAM-токен), `YC_CLOUD_ID`, `YC_FOLDER_ID`.
`yc init` не нужен.

## Ключи сервисов для ycList / ycCreate

`apiGateway`, `certificateManager`, `cdn`, `dns`, `logging`, `postbox`, `containerRegistry`, `iam`,
`lockbox`, `ydb`, `storage`, `serverlessContainers`, `vpc`.
