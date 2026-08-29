/**
 * WebAuthn helpers — wraps @simplewebauthn/server with our DB + rpID logic.
 *
 * rpID: derived from request hostname (or NEXT_PUBLIC_RP_ID env override).
 *   - localhost dev → "localhost"
 *   - your production domain → the domain WebAuthn is scoped to
 *
 * Stored credential fields:
 *   - credentialId: base64url (unique)
 *   - publicKey: base64 (DER-encoded SubjectPublicKeyInfo)
 *   - counter: int (anti-replay)
 *   - transports: JSON array (internal, hybrid, usb, ble, nfc)
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import { db } from "@/lib/db";

export function getRpInfo(req?: Request) {
  const envOverride = process.env.NEXT_PUBLIC_RP_ID;
  if (envOverride) {
    return { rpID: envOverride, rpName: "Finance Tracker" };
  }
  if (req) {
    const url = new URL(req.url);
    return { rpID: url.hostname, rpName: "Finance Tracker" };
  }
  return { rpID: "localhost", rpName: "Finance Tracker" };
}

/**
 * Begin passkey registration. Requires authenticated user (daily session).
 * Returns: registration options JSON to pass to @simplewebauthn/browser's startRegistration().
 */
export async function beginRegistration(userId: string, username: string, req: Request) {
  const { rpID, rpName } = getRpInfo(req);

  // Get existing credentials so user doesn't re-register the same authenticator
  const existingCreds = await db.userWebAuthnCredential.findMany({
    where: { userId },
    select: { credentialId: true, transports: true },
  });

  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: username,
    userDisplayName: username,
    // Don't re-register authenticators already registered for this user
    excludeCredentials: existingCreds.map((c) => ({
      id: c.credentialId,
      type: "public-key",
      transports: (() => {
        try { return JSON.parse(c.transports) as any[]; } catch { return []; }
      })(),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    supportedAlgorithmIDs: [-7, -257], // ES256 + RS256
  });

  // Store the challenge in-memory keyed by userId + challenge (simple — for prod use DB or signed token)
  // For Phase 2: store in globalThis cache (works in serverless for ~seconds)
  if (!globalThis.webauthnChallenges) {
    (globalThis as any).webauthnChallenges = new Map();
  }
  (globalThis as any).webauthnChallenges.set(`reg-${userId}`, options.challenge);
  // Auto-expire after 5 min
  setTimeout(() => (globalThis as any).webauthnChallenges.delete(`reg-${userId}`), 5 * 60 * 1000);

  return options;
}

/**
 * Finish passkey registration. Verifies attestation, stores credential in DB.
 */
export async function finishRegistration(
  userId: string,
  credential: any,
  deviceType?: string,
  req?: Request
): Promise<VerifiedRegistrationResponse> {
  const { rpID } = getRpInfo(req);
  const expectedChallenge = (globalThis as any).webauthnChallenges?.get(`reg-${userId}`);
  if (!expectedChallenge) {
    throw new Error("Registration challenge not found or expired. Please start again.");
  }

  const verification = await verifyRegistrationResponse({
    response: credential,
    expectedChallenge,
    expectedOrigin: getExpectedOrigin(req),
    expectedRPID: rpID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Registration verification failed");
  }

  const regInfo = verification.registrationInfo;
  const credData = regInfo.credential;
  const credentialID = credData.id;
  const credentialPublicKey = credData.publicKey;
  const counter = credData.counter;
  const credentialDeviceType = regInfo.credentialDeviceType;

  // Store credential
  await db.userWebAuthnCredential.create({
    data: {
      userId,
      credentialId: credentialID, // base64url
      publicKey: Buffer.from(credentialPublicKey).toString("base64"),
      counter,
      transports: JSON.stringify(credData.transports ?? []),
      deviceType: credentialDeviceType ?? deviceType ?? null,
    },
  });

  // Cleanup
  (globalThis as any).webauthnChallenges?.delete(`reg-${userId}`);

  return verification;
}

/**
 * Begin passkey login (authentication). Username provided — find user, generate challenge.
 * If username omitted, allow discoverable credentials (resident keys).
 */
export async function beginLogin(username: string | undefined, req: Request) {
  const { rpID } = getRpInfo(req);

  let allowCredentials: any[] = [];
  let userId: string | undefined;
  if (username) {
    const user = await db.user.findUnique({ where: { username } });
    if (!user) {
      throw new Error("User not found");
    }
    userId = user.id;
    const creds = await db.userWebAuthnCredential.findMany({
      where: { userId: user.id },
      select: { credentialId: true, transports: true },
    });
    allowCredentials = creds.map((c) => ({
      id: c.credentialId,
      type: "public-key",
      transports: (() => {
        try { return JSON.parse(c.transports) as any[]; } catch { return []; }
      })(),
    }));
  }

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: "preferred",
  });

  if (!globalThis.webauthnChallenges) {
    (globalThis as any).webauthnChallenges = new Map();
  }
  // Store challenge keyed by userId (if known) OR by the challenge itself for discoverable
  if (userId) {
    (globalThis as any).webauthnChallenges.set(`auth-${userId}`, { challenge: options.challenge, userId });
  } else {
    (globalThis as any).webauthnChallenges.set(`auth-anon-${options.challenge}`, { challenge: options.challenge, userId: null });
  }
  setTimeout(() => {
    (globalThis as any).webauthnChallenges?.delete(`auth-${userId}`);
    (globalThis as any).webauthnChallenges?.delete(`auth-anon-${options.challenge}`);
  }, 5 * 60 * 1000);

  return options;
}

/**
 * Finish passkey login. Verifies assertion, returns user ID for session creation.
 */
export async function finishLogin(
  assertion: any,
  username: string | undefined,
  req?: Request
): Promise<{ userId: string; verified: boolean }> {
  const { rpID } = getRpInfo(req);

  // Find the credential by its ID in the assertion
  const credentialId = assertion.id;
  const cred = await db.userWebAuthnCredential.findUnique({
    where: { credentialId },
  });
  if (!cred) {
    throw new Error("Credential not recognized");
  }

  // Get expected challenge (look up by userId)
  const cached = (globalThis as any).webauthnChallenges?.get(`auth-${cred.userId}`);
  if (!cached) {
    throw new Error("Authentication challenge not found or expired. Please start again.");
  }
  const expectedChallenge = cached.challenge;

  const verification: VerifiedAuthenticationResponse = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge,
    expectedOrigin: getExpectedOrigin(req),
    expectedRPID: rpID,
    credential: {
      id: cred.credentialId,
      publicKey: Buffer.from(cred.publicKey, "base64"),
      counter: cred.counter,
      transports: (() => {
        try { return JSON.parse(cred.transports) as any[]; } catch { return []; }
      })(),
    },
    requireUserVerification: false, // relax for dev — set true for prod
  });

  if (!verification.verified) {
    throw new Error("Authentication verification failed");
  }

  // Update counter (anti-replay)
  if (typeof verification.authenticationInfo?.newCounter === "number") {
    await db.userWebAuthnCredential.update({
      where: { id: cred.id },
      data: { counter: verification.authenticationInfo.newCounter },
    });
  }

  (globalThis as any).webauthnChallenges?.delete(`auth-${cred.userId}`);

  return { userId: cred.userId, verified: true };
}

function getExpectedOrigin(req?: Request): string {
  if (req) {
    const url = new URL(req.url);
    return `${url.protocol}//${url.host}`;
  }
  // Default fallback
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  return "http://localhost:3000";
}
