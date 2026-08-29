/**
 * Generate PNG PWA icons (192, 512, maskable 512) from public/logo SVG mark.
 * Chrome requires PNG icons to trigger the install prompt reliably.
 * Run once: bun run scripts/gen-icons.ts  (outputs are committed to public/)
 */
import sharp from "sharp";
import { mkdir } from "fs/promises";
import path from "path";

const SVG = `<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#059669"/>
  <path d="M154 136h204M154 196h204M192 136c0 110 22 136 88 158M320 136c0 110-22 136-88 158M256 294v75" stroke="#fafaf7" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Maskable needs more safe-zone padding (icon inside 80% area)
const SVG_MASKABLE = `<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#059669"/>
  <g transform="translate(76,76) scale(0.7)">
    <path d="M154 136h204M154 196h204M192 136c0 110 22 136 88 158M320 136c0 110-22 136-88 158M256 294v75" stroke="#fafaf7" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const outDir = path.join(process.cwd(), "public");
await mkdir(outDir, { recursive: true });

await sharp(Buffer.from(SVG)).resize(192, 192).png().toFile(path.join(outDir, "icon-192.png"));
await sharp(Buffer.from(SVG)).resize(512, 512).png().toFile(path.join(outDir, "icon-512.png"));
await sharp(Buffer.from(SVG_MASKABLE)).resize(512, 512).png().toFile(path.join(outDir, "icon-maskable-512.png"));
// Apple touch icon (180)
await sharp(Buffer.from(SVG)).resize(180, 180).png().toFile(path.join(outDir, "apple-touch-icon.png"));

console.log("Icons generated: icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png");
