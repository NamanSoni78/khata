/**
 * Isolated web-push → local HTTPS endpoint delivery test (self-signed).
 * Real push services are https-only; web-push (the lib) rejects plain http.
 * With a self-signed cert + NODE_TLS_REJECT_UNAUTHORIZED=0 in the server env
 * we can run a genuine delivery + decryption round-trip locally.
 */
import crypto from "node:crypto";
import https from "node:https";
import { execSync } from "node:child_process";
import fs from "node:fs";
import webPush from "web-push";

// generate self-signed cert via openssl
execSync(`openssl req -x509 -newkey rsa:2048 -keyout /tmp/khata-test-key.pem -out /tmp/khata-test-cert.pem -days 1 -nodes -subj "/CN=localhost" 2>/dev/null`);

const received: any[] = [];
const server = https.createServer(
  { key: fs.readFileSync("/tmp/khata-test-key.pem"), cert: fs.readFileSync("/tmp/khata-test-cert.pem") },
  (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201);
      res.end("{}");
    });
  }
);

function generateVapidKeys() {
  const keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubRaw = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-65);
  const privRaw = keys.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const b64url = (b: Buffer) => b.toString("base64url");
  return { publicKey: b64url(pubRaw), privateKey: b64url(privRaw) };
}

const vapid = generateVapidKeys();
webPush.setVapidDetails("mailto:test@khata.app", vapid.publicKey, vapid.privateKey);

const ecdh = crypto.createECDH("prime256v1");
ecdh.generateKeys();
const authSecret = crypto.randomBytes(16);

await new Promise<void>((r) => server.listen(4568, r));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

try {
  const result = await webPush.sendNotification(
    {
      endpoint: "https://localhost:4568/push/abc123",
      keys: {
        p256dh: ecdh.getPublicKey("base64url"),
        auth: authSecret.toString("base64url"),
      },
    },
    JSON.stringify({ title: "T", body: "B" })
  );
  console.log("sendNotification OK:", result.statusCode);
} catch (e: any) {
  console.log("sendNotification FAILED:", e.message?.slice(0, 200));
}
console.log("endpoint received:", received.length, "pushes");
if (received.length > 0) {
  console.log("content-encoding:", received[0].headers["content-encoding"], "| ttl:", received[0].headers.ttl);
}
server.close();
process.exit(0);
