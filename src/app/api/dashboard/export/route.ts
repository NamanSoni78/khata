import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";
import PDFDocument from "pdfkit";

export async function GET(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;
  const url = new URL(req.url);

  // ---- Chat-history export: WhatsApp-style .txt transcript ----
  // Downloads BOTH threads (the everyday chat + the dashboard analysis
  // agent), clearly sectioned. This is the archive for messages older than
  // the 50 the home app displays.
  if (url.searchParams.get("type") === "chat") {
    return await exportChatHistory(userId, url);
  }

  const fromDate = url.searchParams.get("from");
  const toDate = url.searchParams.get("to");
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();

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

  const txns = await db.transaction.findMany({
    where,
    orderBy: { timestamp: "asc" },
    include: { fromAccount: true, toAccount: true, contact: true, category: true },
  });

  if (format === "pdf") {
    return await generatePdf(txns, fromDate, toDate);
  }

  // CSV (default)
  const rows = [
    ["Timestamp", "Type", "Amount (INR)", "Category", "From Account", "To Account", "Contact", "Notes"],
  ];
  for (const t of txns) {
    rows.push([
      t.timestamp.toISOString(),
      t.type,
      String(t.amount),
      t.category?.name ?? "",
      t.fromAccount?.name ?? "",
      t.toAccount?.name ?? "",
      t.contact?.name ?? "",
      (t.notes ?? "").replace(/"/g, '""'),
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  const filename = `transactions_${fromDate ?? "all"}_${toDate ?? "now"}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** WhatsApp-style chat transcript export — both threads, human-readable. */
async function exportChatHistory(userId: string, url: URL): Promise<NextResponse> {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const where: any = { userId, role: { in: ["user", "assistant"] } };
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) {
      const t = new Date(to);
      t.setHours(23, 59, 59, 999);
      where.createdAt.lte = t;
    }
  }

  const all = await db.chatMessage.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });

  const isDash = (m: { metadata: string }) => m.metadata?.includes('"source":"dashboard"');
  const daily = all.filter((m) => !isDash(m));
  const dashboard = all.filter(isDash);

  const fmtTime = (d: Date) =>
    d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

  const lines: string[] = [];
  lines.push("Khata — Chat History");
  lines.push(`Exported ${fmtTime(new Date())} (IST)`);
  if (from || to) lines.push(`Range: ${from ?? "(beginning)"} → ${to ?? "(now)"}`);
  lines.push("=".repeat(60));

  const section = (title: string, msgs: typeof all) => {
    lines.push("");
    lines.push(title);
    lines.push("-".repeat(60));
    if (msgs.length === 0) {
      lines.push("(no messages)");
      return;
    }
    let lastDay = "";
    for (const m of msgs) {
      const day = fmtTime(m.createdAt).split(",")[0];
      if (day !== lastDay) {
        lines.push("");
        lines.push(`— ${day} —`);
        lastDay = day;
      }
      const who = m.role === "user" ? "You" : "Khata";
      const time = fmtTime(m.createdAt).split(", ").pop();
      lines.push(`[${time}] ${who}:`);
      lines.push(m.content.trim());
      lines.push("");
    }
  };

  section(`DAILY CHAT (${daily.length} messages) — your everyday app conversation`, daily);
  section(`ANALYSIS AGENT (${dashboard.length} messages) — dashboard deep-dive conversation`, dashboard);

  const filename = `khata_chat_history_${new Date().toISOString().slice(0, 10)}.txt`;
  return new NextResponse(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function generatePdf(
  txns: any[],
  fromDate: string | null,
  toDate: string | null,
): Promise<NextResponse> {
  // Use Helvetica (built-in, no font file needed) so we don't depend on system font paths.
  const doc = new PDFDocument({ size: "A4", margin: 36 });
  doc.font("Helvetica");

  // Stream into a buffer
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const donePromise = new Promise<Buffer>((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  // === Title ===
  doc.fontSize(20).text("Khata — Transactions Report", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor("#666666").text(
    `Generated ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    { align: "center" },
  );
  doc.moveDown(0.3);
  doc.text(
    `Date range: ${fromDate ?? "(beginning)"} → ${toDate ?? "(now)"}`,
    { align: "center" },
  );
  doc.moveDown(0.3);
  doc.text(`Total transactions: ${txns.length}`, { align: "center" });
  doc.moveDown(1);
  doc.fillColor("#000000");

  // === Summary ===
  let income = 0, expense = 0;
  for (const t of txns) {
    if (t.type === "income" || t.type === "profit" || t.type === "loan_in") income += t.amount;
    else if (t.type === "expense" || t.type === "loss" || t.type === "fee" || t.type === "loan_out") expense += t.amount;
  }
  doc.fontSize(12).text(`Total income: ₹${income.toLocaleString("en-IN")}    Total expense: ₹${expense.toLocaleString("en-IN")}    Net: ₹${(income - expense).toLocaleString("en-IN")}`);
  doc.moveDown(1);

  // === Transactions table ===
  const startY = doc.y;
  const colX = [36, 130, 200, 270, 340, 430, 500];
  const rowH = 18;
  doc.fontSize(8);
  doc.font("Helvetica-Bold").fillColor("#000000");
  const headers = ["Date", "Type", "Amount", "Category", "From", "To", "Notes"];
  headers.forEach((h, i) => doc.text(h, colX[i], startY));
  let y = startY + rowH;
  doc.font("Helvetica").fontSize(7);
  // Alternate row stripe
  let stripe = false;
  for (const t of txns) {
    if (y > doc.page.height - 50) {
      doc.addPage();
      y = 36;
      // Repeat header
      doc.font("Helvetica-Bold").fontSize(8);
      headers.forEach((h, i) => doc.text(h, colX[i], y));
      y += rowH;
      doc.font("Helvetica").fontSize(7);
    }
    if (stripe) doc.rect(36, y - 2, doc.page.width - 72, rowH - 2).fillColor("#f5f5f5").fill();
    doc.fillColor("#000000");
    const d = t.timestamp instanceof Date ? t.timestamp : new Date(t.timestamp);
    doc.text(d.toLocaleDateString("en-IN"), colX[0], y);
    doc.text(t.type ?? "", colX[1], y);
    doc.text(`₹${Number(t.amount ?? 0).toLocaleString("en-IN")}`, colX[2], y);
    doc.text(t.category?.name ?? "", colX[3], y, { width: 60, ellipsis: true });
    doc.text(t.fromAccount?.name ?? "", colX[4], y, { width: 60, ellipsis: true });
    doc.text(t.toAccount?.name ?? "", colX[5], y, { width: 60, ellipsis: true });
    doc.text((t.notes ?? "").slice(0, 60), colX[6], y, { width: 100, ellipsis: true });
    y += rowH;
    stripe = !stripe;
  }

  doc.end();
  const buf = await donePromise;
  const filename = `transactions_${fromDate ?? "all"}_${toDate ?? "now"}.pdf`;
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buf.length),
    },
  });
}
