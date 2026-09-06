import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const assetsDir = join(root, 'assets');
const buildDir = join(root, 'build');

// Создаём папку build
mkdirSync(buildDir, { recursive: true });

const svgPath = join(assetsDir, 'icon.svg');
const sizes = [16, 32, 48, 64, 128, 256, 512];

// Генерируем PNG для каждого размера
const pngBuffers = [];
for (const size of sizes) {
  const pngPath = join(buildDir, `icon-${size}.png`);
  await sharp(svgPath)
    .resize(size, size)
    .png()
    .toFile(pngPath);
  console.log(`✅ Создан ${pngPath}`);
  pngBuffers.push({ size, path: pngPath });
}

// Собираем ICO из 16, 32, 48, 64, 128, 256
console.log('\n📦 Собираем .ico...');

// ICO заголовок
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoImages = [];

for (const size of icoSizes) {
  const pngPath = join(buildDir, `icon-${size}.png`);
  const pngData = await sharp(pngPath).raw().toBuffer();
  const pngMeta = await sharp(pngPath).metadata();
  
  // Сначала читаем полный PNG файл (с заголовком)
  const fullPng = await sharp(pngPath).png().toBuffer();
  icoImages.push({
    width: size,
    height: size,
    data: fullPng
  });
}

// Собираем ICO вручную
const headerSize = 6 + icoImages.length * 16;
let offset = headerSize;
const chunks = [];

// ICO header
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);     // reserved
header.writeUInt16LE(1, 2);     // ICO type = 1
header.writeUInt16LE(icoImages.length, 4); // count
chunks.push(header);

// ICO directory entries
for (const img of icoImages) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(img.width === 256 ? 0 : img.width, 0);
  entry.writeUInt8(img.height === 256 ? 0 : img.height, 1);
  entry.writeUInt8(0, 2); // colors
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(img.data.length, 8); // size
  entry.writeUInt32LE(offset, 12); // offset
  offset += img.data.length;
  chunks.push(entry);
}

// ICO image data
for (const img of icoImages) {
  chunks.push(img.data);
}

const icoBuffer = Buffer.concat(chunks);
const icoPath = join(assetsDir, 'icon.ico');
writeFileSync(icoPath, icoBuffer);
console.log(`✅ Создан ${icoPath} (${icoSizes.length} размеров)`);

// PNG для других платформ
const png256Path = join(assetsDir, 'icon.png');
await sharp(svgPath).resize(512, 512).png().toFile(png256Path);
console.log(`✅ Создан ${png256Path}`);

console.log('\n🎉 Иконки готовы!');