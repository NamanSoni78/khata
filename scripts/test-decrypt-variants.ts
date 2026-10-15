/**
 * Fast decrypt-algorithm iteration: web-push encrypts → we decrypt.
 * Tries multiple RFC 8291 interpretation variants to find the right one.
 */
import crypto from "node:crypto";
import https from "node:https";
import { execSync } from "node:child_process";
import fs from "node:fs";
import webPush from "web-push";

execSync(`openssl req -x509 -newkey rsa:2048 -keyout /tmp/khata-test-key.pem -out /tmp/khata-test-cert.pem -days 1 -nodes -subj "/CN=localhost" 2>/dev/null`);

let captured: Buffer | null = null;
const server = https.createServer(
  { key: fs.readFileSync("/tmp/khata-test-key.pem"), cert: fs.readFileSync("/tmp/khata-test-cert.pem") },
  (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured = Buffer.concat(chunks);
      res.writeHead(201);
      res.end("{}");
    });
  }
);

const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubRaw = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-65);
const privRaw = keys.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
const b64url = (b: Buffer) => b.toString("base64url");
webPush.setVapidDetails("mailto:t@t.app", b64url(pubRaw), b64url(privRaw));

const ecdh = crypto.createECDH("prime256v1");
ecdh.generateKeys();
const authSecret = crypto.randomBytes(16);
const uaPublic = Buffer.from(ecdh.getPublicKey("base64url"), "base64url");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
await new Promise<void>((r) => server.listen(4568, r));
await webPush.sendNotification(
  { endpoint: "https://localhost:4568/push/x", keys: { p256dh: ecdh.getPublicKey("base64url"), auth: authSecret.toString("base64url") } },
  JSON.stringify({ title: "Khata test", body: "hello bhai" })
);
server.close();
console.log("captured body:", captured!.length, "bytes");

const body = captured!;
const salt = body.subarray(0, 16);
const idlen = body[20];
const keyId = body.subarray(21, 21 + idlen);
const ciphertext = body.subarray(21 + idlen);
const Z = ecdh.computeSecret(keyId);
const ikm = Buffer.concat([Z, authSecret]);

function tryDecrypt(name: string, cek: Buffer, nonce: Buffer): boolean {
  try {
    const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
    d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
    let end = plain.length;
    while (end > 0 && plain[end - 1] === 0) end--;
    const s = plain.subarray(0, end).toString("utf8");
    console.log(`✓✓✓ ${name} DECRYPTED:`, s);
    return true;
  } catch {
    console.log(`✗ ${name} failed`);
    return false;
  }
}

// PRK per RFC 8291: HKDF(salt, ikm, "WebPush: info\0"||ua_public, 32)
const prkA = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.concat([Buffer.from("WebPush: info\x00"), uaPublic]), 32));

// Variant 1: CEK/NONCE via node hkdfSync (Extract+Expand with empty salt)
const v1cek = Buffer.from(crypto.hkdfSync("sha256", prkA, Buffer.alloc(0), Buffer.from("Content-Encoding: aes128gcm\x00"), 16));
const v1nonce = Buffer.from(crypto.hkdfSync("sha256", prkA, Buffer.alloc(0), Buffer.from("Content-Encoding: nonce\x00"), 12));
tryDecrypt("V1 full-hkdf", v1cek, v1nonce);

// Variant 2: CEK/NONCE via HKDF-Expand only (raw expand on PRK)
function hkdfExpand(prk: Buffer, info: Buffer, len: number): Buffer {
  const hmac = crypto.createHmac("sha256", prk);
  const t = Buffer.concat([hmac.update(info).digest(), Buffer.alloc(0)]);
  // standard expand for len <= 32: T(1) = HMAC(PRK, info || 0x01)
  return crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, len);
}
const v2cek = hkdfExpand(prkA, Buffer.from("Content-Encoding: aes128gcm\x00"), 16);
const v2nonce = hkdfExpand(prkA, Buffer.from("Content-Encoding: nonce\x00"), 12);
tryDecrypt("V2 expand-only", v2cek, v2nonce);

// Variant 3: PRK without ua_public suffix
const prkB = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("WebPush: info\x00"), 32));
const v3cek = Buffer.from(crypto.hkdfSync("sha256", prkB, Buffer.alloc(0), Buffer.from("Content-Encoding: aes128gcm\x00"), 16));
const v3nonce = Buffer.from(crypto.hkdfSync("sha256", prkB, Buffer.alloc(0), Buffer.from("Content-Encoding: nonce\x00"), 12));
tryDecrypt("V3 no-ua-public", v3cek, v3nonce);

// Variant 4: old aesgcm-style auth PRK then aes128gcm CEKs
const prkC = Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from("Content-Encoding: auth\x00"), 32));
const ikm2 = Buffer.concat([prkC, salt]);
const cek4 = Buffer.from(crypto.hkdfSync("sha256", ikm2, Buffer.alloc(0), Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\x00"), uaPublic]), 16));
const nonce4 = Buffer.from(crypto.hkdfSync("sha256", ikm2, Buffer.alloc(0), Buffer.concat([Buffer.from("Content-Encoding: nonce\x00"), uaPublic]), 12));
tryDecrypt("V4 legacy-mix", cek4, nonce4);


// Variant 5: http_ece reference implementation decrypt
const ece = (await import("http_ece")).default ?? (await import("http_ece"));
try {
  const plain = ece.decrypt(body, {
    version: "aes128gcm",
    privateKey: ecdh,
    authSecret: authSecret.toString("base64url"),
    dh: keyId.toString("base64url"),
  });
  console.log("✓✓✓ V5 http_ece DECRYPTED:", plain.toString("utf8"));
} catch (e: any) {
  console.log("✗ V5 http_ece failed:", e.message);
}
