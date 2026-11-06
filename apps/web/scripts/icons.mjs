// Makes the app icons and the logo files from src/app/icon.svg: `node apps/web/scripts/icons.mjs`.
// Installed app (manifest): 192 and 512 px, plus "maskable" ones with room for round and squircle masks.
// Google sign-in consent screen: brand/free-me-logo-120.png (Google asks for 120×120).
import sharp from 'sharp';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(web, 'src/app/icon.svg'));
const out = (p) => join(web, 'public', p);
await mkdir(out('icons'), { recursive: true });
await mkdir(out('brand'), { recursive: true });

/** The logo centred on a square: `scale` of the side is the logo, the rest is `bg`. */
async function icon(size, scale, bg, file) {
  const inner = Math.round(size * scale);
  const logo = await sharp(svg, { density: 1200 }).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: bg } }).composite([{ input: logo, gravity: 'centre' }]).png({ compressionLevel: 9 }).toFile(out(file));
}
const white = { r: 255, g: 255, b: 255, alpha: 1 };
await icon(192, 0.72, white, 'icons/icon-192.png');
await icon(512, 0.72, white, 'icons/icon-512.png');
// Maskable: Android may cut to a circle; the logo stays inside the middle 60%.
await icon(192, 0.56, white, 'icons/maskable-192.png');
await icon(512, 0.56, white, 'icons/maskable-512.png');
await icon(120, 0.8, white, 'brand/free-me-logo-120.png');
await icon(512, 0.8, white, 'brand/free-me-logo-512.png');
await icon(96, 0.72, white, 'icons/shortcut-upload.png');
console.log('icons written');
