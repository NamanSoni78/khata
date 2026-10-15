import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

const SALT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function hashMpin(plain: string): Promise<string> {
  // MPINs are short (4-6 digits) — use higher salt rounds to slow brute force
  return bcrypt.hash(plain, 12);
}

export async function verifyMpin(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}
