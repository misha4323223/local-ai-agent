# Windows и системные операции

Справочник агента. Подключается автоматически, когда задача про саму ОС (группа `system`),
читается вручную: `agentGuide { name: "system" }`.

Для задач про операционную систему используй специальные инструменты, а не голые команды.

## Процессы

- `listProcesses` — найти процесс и его PID.
- `killProcess` — завершить зависший процесс (спросит подтверждение).

## Экран, буфер, файлы

- `screenshotDesktop` — скриншот ЭКРАНА или окна (не страницы!) — показывается пользователю во встроенном просмотрщике.
- `clipboardWrite` / `clipboardRead` — буфер обмена.
- `openPath` — открыть файл системным приложением (PDF, картинка вне проекта).

## Реестр Windows

- `registryRead` — чтение разрешено только из разделов SOFTWARE, ENVIRONMENT, SYSTEM, SECURITY.
- `registryWrite` — запись только в HKCU\Software и HKCU\Environment, спросит подтверждение.

## Установка программ

- `installSystemPackage` — на Windows сам выберет winget, choco или scoop; на macOS — brew; Linux — apt/dnf/apk.
- `wingetSearch` — поиск пакета по имени (Windows).
- `installExe` — установка скачанного установщика (.exe, .msi и .zip), спросит подтверждение.
- `checkInstalledProgram` — проверить, установлена ли программа.

## Оболочки (важно)

По умолчанию на Windows команды идут в `cmd.exe`, на macOS/Linux — в `sh`. Для PowerShell и bash есть
параметр `shell` у `runCommand` и `startBackground`:

- `shell: "powershell"` — настоящий PowerShell с включённым UTF-8 (кириллица, `$`, кавычки и `2>$null`
  работают как в консоли, обёртка `powershell -Command` не нужна);
- `shell: "bash"` — bash (на Windows это Git Bash, ставится вместе с Git for Windows), `sh` ищется там же.

Если не знаешь, какие оболочки есть на машине, вызови `shellsStatus` — он покажет доступные с путями и
подсказкой, что установить. Не выясняй это методом проб: `bash`/`sh` на Windows без Git for Windows отсутствуют.
