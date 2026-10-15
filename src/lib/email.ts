/**
 * Email (Resend) + Gmail validation + OTP helpers.
 *
 * GMAIL RULES (product decision):
 *  - Only @gmail.com addresses are supported.
 *  - Local part must be plain letters+digits (4–30 chars) — addresses with
 *    dots (some.thing@gmail.com) or +tags (some+thing@gmail.com) are
 *    REJECTED, because Gmail treats those aliases as the same inbox and they
 *    would allow unlimited duplicate accounts.
 *
 * RESEND (https://resend.com — free tier: 100 mails/day):
 *  - Env: RESEND_API_KEY
 *  - Optional: RESEND_FROM (default: "Khata <no-reply@khata.namansoni.in>")
 *    NOTE: sending from a custom domain requires verifying khata.namansoni.in
 *    in the Resend dashboard (add the DKIM + SPF records they show you).
 *
 * DEV MODE: when no RESEND_API_KEY is set AND EMAIL_DEV_MODE=true (or running
 * outside production), the OTP is returned in the API response / logged so
 * local testing works without an email provider. NEVER set EMAIL_DEV_MODE in
 * production.
 */
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/auth/credentials";
import { randomInt } from "crypto";

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000; // min gap between two sends

// ============================================================
//  Gmail validation
// ============================================================

export interface GmailCheck {
  ok: boolean;
  email?: string; // normalized (lowercase)
  reason?: string; // user-friendly rejection reason
}

export function validateGmail(raw: string): GmailCheck {
  const email = (raw ?? "").trim().toLowerCase();
  if (!email) return { ok: false, reason: "Enter your Gmail address" };
  if (!email.endsWith("@gmail.com")) {
    return { ok: false, reason: "Only @gmail.com addresses are supported" };
  }
  const local = email.slice(0, -"@gmail.com".length);
  if (local.includes("+") || local.includes(".")) {
    return {
      ok: false,
      reason: "Please use a plain Gmail address without dots or +tags (e.g. rahul@gmail.com)",
    };
  }
  if (!/^[a-z0-9]{4,30}$/.test(local)) {
    return {
      ok: false,
      reason: "Gmail addresses here use letters and numbers only (no dots or +tags)",
    };
  }
  return { ok: true, email };
}

/** Generate a display username from a gmail local part, ensuring uniqueness. */
export async function uniqueUsernameFromEmail(localPart: string): Promise<string> {
  const base = localPart.slice(0, 24);
  let candidate = base;
  for (let i = 0; i < 50; i++) {
    const exists = await db.user.findUnique({ where: { username: candidate } });
    if (!exists) return candidate;
    candidate = `${base}${Math.floor(randomInt(10, 999))}`;
  }
  return `${base}${Date.now().toString(36).slice(-4)}`;
}

// ============================================================
//  OTP issue / verify (DB-backed, hashed)
// ============================================================

export type OtpPurpose = "signup" | "forgot";

function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export interface OtpIssueResult {
  ok: boolean;
  /** Set when the caller must wait before requesting another code. */
  retryAfterSec?: number;
  /** Dev-only: the plain code, surfaced when email isn't configured. */
  devCode?: string;
  /** True when the mail was actually dispatched. */
  sent: boolean;
  error?: string;
}

/**
 * Issue a fresh OTP for (userId, purpose): invalidates previous codes,
 * enforces a 60s resend cooldown, stores a bcrypt hash with 10min expiry,
 * and sends the email via Resend.
 */
export async function issueOtp(
  userId: string,
  email: string,
  purpose: OtpPurpose
): Promise<OtpIssueResult> {
  // Resend cooldown: last code for this purpose issued <60s ago?
  const recent = await db.otpCode.findFirst({
    where: { userId, purpose, createdAt: { gte: new Date(Date.now() - RESEND_COOLDOWN_MS) } },
    orderBy: { createdAt: "desc" },
  });
  if (recent) {
    const wait = Math.ceil(
      (recent.createdAt.getTime() + RESEND_COOLDOWN_MS - Date.now()) / 1000
    );
    return { ok: false, retryAfterSec: Math.max(1, wait), sent: false, error: "cooldown" };
  }

  const code = generateOtp();

  // Invalidate all previous live codes for this purpose
  await db.otpCode.updateMany({
    where: { userId, purpose, consumed: false },
    data: { consumed: true },
  });

  await db.otpCode.create({
    data: {
      userId,
      purpose,
      codeHash: await hashPassword(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
  });

  // Send the email (or dev-mode fallback)
  const mail = await sendOtpEmail(email, code, purpose);
  if (!mail.ok && !mail.devFallback) {
    return { ok: false, sent: false, error: mail.error ?? "Could not send email" };
  }
  return { ok: true, sent: mail.ok, devCode: mail.devFallback ? code : undefined };
}

export interface OtpVerifyResult {
  ok: boolean;
  error?: string;
}

/**
 * Verify an OTP for (userId, purpose) and consume it on success.
 * Handles: expired, already-used, too many attempts (invalidates the code).
 */
export async function verifyOtp(
  userId: string,
  purpose: OtpPurpose,
  code: string
): Promise<OtpVerifyResult> {
  const normalized = (code ?? "").replace(/\D/g, "");
  if (normalized.length !== 6) return { ok: false, error: "Enter the 6-digit code" };

  const row = await db.otpCode.findFirst({
    where: { userId, purpose, consumed: false },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return { ok: false, error: "No active code — request a new one" };

  if (row.expiresAt.getTime() < Date.now()) {
    await db.otpCode.update({ where: { id: row.id }, data: { consumed: true } });
    return { ok: false, error: "That code expired — request a new one" };
  }

  const good = await verifyPassword(normalized, row.codeHash);
  if (!good) {
    const attempts = row.attempts + 1;
    await db.otpCode.update({
      where: { id: row.id },
      data: { attempts, consumed: attempts >= OTP_MAX_ATTEMPTS },
    });
    if (attempts >= OTP_MAX_ATTEMPTS) {
      return { ok: false, error: "Too many wrong tries — request a new code" };
    }
    return { ok: false, error: "That code isn't right" };
  }

  await db.otpCode.update({ where: { id: row.id }, data: { consumed: true } });
  return { ok: true };
}

// ============================================================
//  Resend (REST — no SDK needed)
// ============================================================

interface SendResult {
  ok: boolean;
  /** true when email isn't configured and dev mode kicked in */
  devFallback?: boolean;
  error?: string;
}

export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

async function sendOtpEmail(to: string, code: string, purpose: OtpPurpose): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const devMode = process.env.EMAIL_DEV_MODE === "true" || process.env.NODE_ENV !== "production";
    if (devMode) {
      console.log(`[email:dev] OTP for ${to} (${purpose}): ${code}`);
      return { ok: false, devFallback: true };
    }
    return { ok: false, error: "Email is not configured on this server (RESEND_API_KEY missing)" };
  }

  const from = process.env.RESEND_FROM || "Khata <no-reply@khata.namansoni.in>";
  const subject =
    purpose === "signup" ? `${code} is your Khata verification code` : `${code} — reset your Khata password`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, html: otpEmailHtml(code, purpose) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[email] Resend error:", res.status, text);
      return { ok: false, error: `Email provider error (${res.status})` };
    }
    return { ok: true };
  } catch (e) {
    console.error("[email] Resend fetch failed:", e);
    return { ok: false, error: "Could not reach the email provider" };
  }
}

function otpEmailHtml(code: string, purpose: OtpPurpose): string {
  const heading = purpose === "signup" ? "Verify your email" : "Reset your password";
  const line =
    purpose === "signup"
      ? "Enter this code to finish creating your Khata account."
      : "Enter this code to choose a new password for your Khata account.";
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#efeae2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#efeae2;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:420px;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#008069;padding:20px 24px;">
          <p style="margin:0;color:#ffffff;font-size:17px;font-weight:600;">Khata</p>
          <p style="margin:2px 0 0;color:#c8e6dd;font-size:12px;">Your daily money diary</p>
        </td></tr>
        <tr><td style="padding:28px 24px 8px;">
          <p style="margin:0 0 6px;color:#111b21;font-size:16px;font-weight:600;">${heading}</p>
          <p style="margin:0 0 20px;color:#3b4a54;font-size:14px;line-height:1.5;">${line}</p>
        </td></tr>
        <tr><td style="padding:0 24px 8px;" align="center">
          <div style="display:inline-block;border:1px solid #d1d7db;border-bottom:3px solid #008069;border-radius:10px;padding:14px 28px;">
            <span style="font-size:30px;letter-spacing:10px;color:#111b21;font-weight:600;">${code}</span>
          </div>
        </td></tr>
        <tr><td style="padding:16px 24px 28px;">
          <p style="margin:0;color:#667781;font-size:12px;line-height:1.5;">This code expires in 10 minutes. If you didn't ask for it, you can safely ignore this email.</p>
        </td></tr>
        <tr><td style="padding:14px 24px;background:#f0f2f5;">
          <p style="margin:0;color:#667781;font-size:11px;">Khata · <a href="https://khata.namansoni.in/terms" style="color:#008069;">Terms</a> · <a href="https://khata.namansoni.in/privacy" style="color:#008069;">Privacy</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
