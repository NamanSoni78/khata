import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";
import { getQStashAccounts } from "@/lib/qstash-pool";
import { isEmailConfigured } from "@/lib/email";

export async function GET() {
  const token = await getSessionToken("admin");
  const user = await getSessionUser(token, "admin");
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [
    users,
    accounts,
    transactions,
    contacts,
    categories,
    chatMessages,
    adminConfigs,
  ] = await Promise.all([
    db.user.count({ where: { id: { not: "admin" } } }),
    db.account.count(),
    db.transaction.count(),
    db.contact.count(),
    db.category.count(),
    db.chatMessage.count(),
    db.adminConfig.count(),
  ]);
  return NextResponse.json({
    counts: { users, accounts, transactions, contacts, categories, chatMessages, adminConfigs },
    database: {
      provider: "sqlite (libSQL / Turso)",
      urlMasked: process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":****@"),
      remote: /^libsql:|^wss:|^https:/i.test(process.env.DATABASE_URL ?? ""),
    },
    env: {
      hasAdminCreds: !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD),
      hasVapidKeys: !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
      hasVapidSubject: !!process.env.VAPID_SUBJECT,
      qstashAccounts: getQStashAccounts().length,
      hasQStash: getQStashAccounts().length > 0,
      hasResend: isEmailConfigured(),
    },
  });
}
