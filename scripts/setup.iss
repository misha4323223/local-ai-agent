; Inno Setup скрипт для AI Developer Agent
; Используется скриптом scripts/dist-win.mjs (bun run dist:win:installer)
; или вручную: iscc scripts/setup.iss

#define MyAppName "AI Developer Agent"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "AI Dev"
#define MyAppExeName "ai_agent.exe"

[Setup]
; ВНИМАНИЕ: AppId должен быть уникальным. Оставь как есть или сгенерируй свой.
AppId={{9F7C2E4B-5A1D-4C8E-9B2F-3D6E8A1B4C5D}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
OutputDir=..\dist
OutputBaseFilename=ai_agent-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Приложение 64-битное
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Вся папка Release (exe + все dll) — без этого приложение не запустится
Source: "..\dist\ai_agent\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
