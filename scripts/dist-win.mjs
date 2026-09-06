// Скрипт сборки Windows-версии AI Developer Agent.
// Запуск: bun run dist:win        (или: bun run dist:win:installer)
//
// Что делает:
//   1. flutter pub get — подтягивает зависимости
//   2. flutter build windows --release — собирает exe
//   3. Копирует готовое приложение в dist/ai_agent/
//   4. (опционально) Собирает ZIP для переноса
//   5. (опционально, --installer) Собирает установщик через Inno Setup,
//      если iscc.exe найден на компьютере
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(root, 'build', 'windows', 'x64', 'runner', 'Release');
const distDir = join(root, 'dist');
const outDir = join(distDir, 'ai_agent');
const zipPath = join(distDir, 'ai_agent-windows.zip');
const withInstaller = process.argv.includes('--installer');

function run(cmd, args, opts = {}) {
  const display = [cmd, ...args].join(' ');
  console.log(`\n> ${display}`);
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`\n❌ Команда не удалась: ${display}`);
    process.exit(result.status ?? 1);
  }
}

function findIscc() {
  const candidates = [
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files (x86)\\Inno Setup 5\\ISCC.exe',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

console.log('==============================================');
console.log('  Сборка Windows-версии AI Developer Agent');
console.log('==============================================');

// 1. Зависимости
run('flutter', ['pub', 'get']);

// 2. Сборка
run('flutter', ['build', 'windows', '--release']);

// 3. Копируем собранное приложение в dist/ai_agent/
if (!existsSync(releaseDir)) {
  console.error(`\n❌ Не найдена папка со сборкой: ${releaseDir}`);
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(releaseDir, outDir, { recursive: true });
console.log(`\n✅ Приложение скопировано в: dist\\ai_agent\\`);
console.log(`   Запуск: dist\\ai_agent\\ai_agent.exe`);

// 4. ZIP для переноса на другой ПК
if (process.platform === 'win32') {
  rmSync(zipPath, { force: true });
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${outDir}' -DestinationPath '${zipPath}' -Force`,
  ]);
  console.log(`✅ Переносная версия: dist\\ai_agent-windows.zip`);
} else {
  console.log(`\nℹ️  Ты не на Windows — ZIP не собираю. Запусти скрипт на Windows.`);
}

// 5. Установщик через Inno Setup (если установлен)
if (withInstaller) {
  const iscc = findIscc();
  if (iscc) {
    run(iscc, [join(root, 'scripts', 'setup.iss')]);
    console.log(`\n✅ Установщик собран: dist\\ai_agent-setup.exe`);
  } else {
    console.log(
      '\n⚠️  Inno Setup не найден. Установи его с https://jrsoftware.org/isinfo.php\n' +
      '    (или просто используй ZIP-версию из dist\\ai_agent-windows.zip)'
    );
  }
}

console.log('\n==============================================');
console.log('  Готово! 🎉');
console.log('==============================================');
