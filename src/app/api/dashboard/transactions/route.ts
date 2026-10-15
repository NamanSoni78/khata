import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;
  const url = new URL(req.url);
  const fromDate = url.searchParams.get("from");
  const toDate = url.searchParams.get("to");
  const type = url.searchParams.get("type");
  const accountId = url.searchParams.get("accountId");
  const limit = Number(url.searchParams.get("limit") ?? 200);

  const where: any = { userId };
  if (fromDate || toDate) {
    where.timestamp = {};
    if (fromDate) where.timestamp.gte = new Date(fromDate);
    if (toDate) {
      const t = new Date(toDate);
      t.setHours(23, 59, 59, 999);
      where.timestamp.lte = t;
    }
  }
  if (type) where.type = type;
  if (accountId) {
    where.OR = [{ fromAccountId: accountId }, { toAccountId: accountId }];
  }

  const txns = await db.transaction.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: limit,
    include: { fromAccount: true, toAccount: true, contact: true, category: true },
  });

  return NextResponse.json({
    transactions: txns.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      timestamp: t.timestamp.toISOString(),
      category: t.category?.name,
      fromAccount: t.fromAccount?.name,
      toAccount: t.toAccount?.name,
      contact: t.contact?.name,
      notes: t.notes,
    })),
  });
}
