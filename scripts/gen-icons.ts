/**
 * Generate PNG PWA icons (192, 512, maskable 512) from public/logo SVG mark.
 * Chrome requires PNG icons to trigger the install prompt reliably.
 * Run once: bun run scripts/gen-icons.ts  (outputs are committed to public/)
 */
import sharp from "sharp";
import { mkdir } from "fs/promises";
import path from "path";

const SVG = `<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#008069"/>
  <path d="M154 136h204M154 196h204M192 136c0 110 22 136 88 158M320 136c0 110-22 136-88 158M256 294v75" stroke="#fafaf7" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Maskable needs more safe-zone padding (icon inside 80% area)
const SVG_MASKABLE = `<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#008069"/>
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


// --- OG image (1200x630) — WhatsApp-style chat mockup ---
const OG = `<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#efeae2"/>
  <rect width="1200" height="118" fill="#008069"/>
  <circle cx="64" cy="59" r="26" fill="#ffffff" fill-opacity="0.18"/>
  <path d="M55 47h18M55 53h18M59 47c0 12 2.4 15 9.6 17.4M69 47c0 12-2.4 15-9.6 17.4M64 64.4v8.2" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="106" y="55" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="30" font-weight="600" fill="#ffffff">Khata</text>
  <text x="106" y="82" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="17" fill="#c8e6dd">Your daily money diary</text>

  <g>
    <rect x="90" y="190" width="560" height="66" rx="10" fill="#ffffff"/>
    <path d="M90 190 L78 190 L90 202 Z" fill="#ffffff"/>
    <text x="112" y="230" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="21" fill="#111b21">aaj 20 rs rapido ke kharch hue</text>
    <text x="508" y="242" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="12" fill="#667781">9:41</text>
  </g>
  <g>
    <rect x="550" y="290" width="480" height="66" rx="10" fill="#d9fdd3"/>
    <path d="M1030 290 L1042 290 L1030 302 Z" fill="#d9fdd3"/>
    <text x="572" y="330" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="21" fill="#111b21">Logged Rs 20 for Transport.</text>
    <text x="900" y="342" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="12" fill="#667781">9:41</text>
  </g>
  <g>
    <rect x="90" y="390" width="640" height="66" rx="10" fill="#ffffff"/>
    <path d="M90 390 L78 390 L90 402 Z" fill="#ffffff"/>
    <text x="112" y="430" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="21" fill="#111b21">mere dost Rahul ne 30 hazar diye IPO ke liye</text>
    <text x="598" y="442" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="12" fill="#667781">9:42</text>
  </g>
  <g>
    <rect x="550" y="490" width="530" height="66" rx="10" fill="#d9fdd3"/>
    <path d="M1080 490 L1092 490 L1080 502 Z" fill="#d9fdd3"/>
    <text x="572" y="530" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="21" fill="#111b21">Logged 3 linked legs of the IPO plan.</text>
    <text x="950" y="542" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif" font-size="12" fill="#667781">9:42</text>
  </g>

  <g>
    <rect x="60" y="580" width="1080" height="2" fill="#d1d7db"/>
    <rect x="80" y="594" width="760" height="30" rx="15" fill="#ffffff" stroke="#d1d7db"/>
    <circle cx="1096" cy="609" r="17" fill="#008069"/>
    <path d="M1090 609 a6 6 0 0 1 12 0 v4 a6 6 0 0 1 -12 0 z M1096 613 v3 l3 2" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>
</svg>`;
await sharp(Buffer.from(OG)).png().toFile(path.join(outDir, "og.png"));
console.log("OG image generated: og.png");
console.log("Icons generated: icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png, og.png");
