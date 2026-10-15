/**
 * Generate VAPID keypair for Web Push notifications.
 * Sets the public key as NEXT_PUBLIC_VAPID_PUBLIC_KEY and private as VAPID_PRIVATE_KEY
 * (you must add these to your Vercel env vars manually).
 *
 * Usage: bun run scripts/gen-vapid.ts
 */
import webPush from "web-push";

const keys = webPush.generateVAPIDKeys();
console.log("VAPID keypair generated. Add these to Vercel env vars:");
console.log("");
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("");
console.log("Also set VAPID_SUBJECT=mailto:you@example.com (any email works).");
