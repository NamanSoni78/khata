import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { getFeatureFlags, getOcrConfig, getDailyAgentConfig } from "@/lib/admin-config";
import { db } from "@/lib/db";
import { chatComplete, chatCompleteVision, type LLMMessage } from "@/lib/llm/client";
import { DAILY_TOOLS } from "@/lib/agent/tools-defs";
import { dispatchTool } from "@/lib/agent/tools";
import { buildDailySystemPrompt } from "@/lib/agent/prompt-builder";

/**
 * POST /api/chat/upload-statement
 * Accepts: multipart/form-data with `file` field (PDF, image, or text)
 * Flow:
 *   - PDF: parse with pdf-parse to raw text
 *   - Image (jpg/png/webp): if featureFlags.ocr && ocr.enabled && ocr.apiKey, call chatCompleteVision to extract transaction text/JSON
 *   - Text (paste mode): use as-is
 *   2. Ask LLM to extract structured transactions as JSON array (skip this step if OCR already returned JSON)
 *   3. Compare each extracted txn vs user's recent txns (within ±3 days + ±5% amount)
 *   4. For new txns: ask LLM whether to log them (uses log_expense/log_income tools)
 *   5. For potential duplicates: ask user (returns them in response for UI review)
 *   6. Returns: { summary, duplicates: [...], new_logged: [...], questions: [...] }
 */
const IMAGE_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

export async function POST(req: NextRequest) {
  const token = await getSessionToken("daily");
  const user = await getSessionUser(token, "daily");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = user.id;

  const flags = await getFeatureFlags();
  const ocrConfig = await getOcrConfig();

  const formData = await req.formData();
  const file = formData.get("file");
  const pasteText = formData.get("text");
  let rawText = "";
  let usedOcr = false;
  let ocrTransactionJson: any[] | null = null; // if OCR returns structured JSON directly, we skip the text→JSON step

  if (file instanceof File) {
    if (file.size > 10_000_000) {
      return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 413 });
    }
    const buf = Buffer.from(await file.arrayBuffer());

    if (file.type === "application/pdf") {
      if (!flags.pdfUpload) {
        return NextResponse.json({ error: "PDF upload disabled by admin" }, { status: 403 });
      }
      try {
        // pdf-parse v2 exports the PDFParse class (no default function export anymore)
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(buf) });
        const result = await parser.getText();
        rawText = result.text;
        await parser.destroy();
      } catch (e: any) {
        return NextResponse.json({
          error: `PDF parse failed: ${e?.message ?? "unknown"}`,
        }, { status: 422 });
      }
    } else if (IMAGE_MIME_TYPES.includes(file.type)) {
      // Image — use OCR if enabled
      if (!flags.ocr || !ocrConfig.enabled) {
        return NextResponse.json({
          error: "Image uploads aren't enabled yet. Please contact your administrator.",
        }, { status: 403 });
      }
      if (!ocrConfig.apiKey) {
        return NextResponse.json({
          error: "Image uploads aren't fully set up yet. Please contact your administrator.",
        }, { status: 503 });
      }
      try {
        const base64 = buf.toString("base64");
        const ocrPrompt = `You are an OCR + extraction agent. The user has uploaded an image of a bank statement, receipt, or transaction record. Extract ALL transactions as a JSON array.

Each item must be: { "date": "YYYY-MM-DD" | null, "description": "...", "amount": number, "type": "credit" | "debit", "balance_after": number | null }

- type: "credit" = money IN, "debit" = money OUT
- amount: always positive number
- description: the memo/payee text from the document
- date: ISO date if parseable, else null
- balance_after: post-txn balance if shown, else null

Return ONLY the JSON: { "transactions": [...] } — no markdown, no commentary.`;
        const visionRes = await chatCompleteVision(
          ocrConfig,
          [{ base64, mimeType: file.type }],
          ocrPrompt,
          { forceJsonOutput: true }
        );
        // Try to parse the JSON directly
        const jsonMatch = visionRes.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed.transactions)) {
              ocrTransactionJson = parsed.transactions;
              usedOcr = true;
              rawText = `[Extracted via OCR — ${parsed.transactions.length} transactions]`;
            } else {
              // OCR returned plain text — treat as raw text and re-extract via the LLM
              rawText = visionRes.content;
              usedOcr = true;
            }
          } catch {
            // JSON parse failed — fall back to text
            rawText = visionRes.content;
            usedOcr = true;
          }
        } else {
          rawText = visionRes.content;
          usedOcr = true;
        }
      } catch (e: any) {
        return NextResponse.json({
          error: `OCR extraction failed: ${e?.message ?? "unknown"}`,
        }, { status: 502 });
      }
    } else {
      return NextResponse.json({
        error: `Unsupported file type: ${file.type}. Supported: PDF, JPEG, PNG, WebP.`,
      }, { status: 415 });
    }
  } else if (typeof pasteText === "string" && pasteText.trim().length > 0) {
    if (!flags.pdfUpload) {
      return NextResponse.json({ error: "Paste-mode upload disabled by admin" }, { status: 403 });
    }
    rawText = pasteText;
  } else {
    return NextResponse.json({ error: "No file or text provided" }, { status: 400 });
  }

  // For non-OCR (PDF or paste), require minimum text length
  if (!usedOcr && rawText.length < 50) {
    return NextResponse.json({
      error: "Statement text is too short or empty. Is this a valid bank statement PDF?",
    }, { status: 422 });
  }

  // Truncate very long raw text to fit in context (only matters for PDF/paste; OCR already structured)
  if (!ocrTransactionJson) {
    rawText = rawText.slice(0, 15000);
  }

  // Step 1: ask LLM to extract structured transactions (if OCR didn't already)
  const config = await getDailyAgentConfig();
  if (!config.apiKey) {
    return NextResponse.json({
      error: "The assistant isn't set up yet. Please contact your administrator.",
    }, { status: 503 });
  }

  // Step 2: get user's last 90 days of txns for duplicate detection
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const existingTxns = await db.transaction.findMany({
    where: { userId, timestamp: { gte: cutoff } },
    include: { fromAccount: true, toAccount: true, contact: true, category: true },
    orderBy: { timestamp: "desc" },
    take: 200,
  });

  const existingSummary = existingTxns.map((t) => ({
    id: t.id,
    type: t.type,
    amount: t.amount,
    category: t.category?.name,
    timestamp: t.timestamp.toISOString().slice(0, 10),
    from_account: t.fromAccount?.name,
    to_account: t.toAccount?.name,
    contact: t.contact?.name,
    notes: t.notes,
  }));

  // Step 3: ask LLM to extract + match (skip if OCR already returned structured JSON)
  let extracted: { transactions: any[]; duplicates: any[]; new_txns: number[] };

  if (ocrTransactionJson) {
    // OCR already gave us the transactions; we still need to match against existing txns
    // Use the daily agent to do just the duplicate-matching step
    const matchPrompt = `You are a duplicate-detector. Below is a list of NEW transactions (extracted from a user-uploaded image) and the user's EXISTING transactions. For each new txn, check if it matches an existing one (same amount ±5%, within ±3 days).

Return JSON: { "duplicates": [{ "extracted_index": number, "existing_txn_id": string, "existing_amount": number, "existing_timestamp": string }], "new_txns": [indices that are NOT duplicates] }

Return ONLY the JSON, no commentary.

=== NEW (EXTRACTED) TRANSACTIONS ===
${JSON.stringify(ocrTransactionJson.map((t, i) => ({ index: i, ...t })), null, 2)}

=== USER'S EXISTING TRANSACTIONS (last 90 days) ===
${JSON.stringify(existingSummary, null, 2)}`;
    try {
      const res = await chatComplete(config, [
        { role: "system", content: matchPrompt },
        { role: "user", content: "Match and return JSON." },
      ], [], { forceJsonOutput: true });
      const jsonMatch = res.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return NextResponse.json({
          error: "LLM did not return valid JSON for duplicate detection",
          raw: res.content.slice(0, 500),
        }, { status: 502 });
      }
      const matched = JSON.parse(jsonMatch[0]);
      extracted = {
        transactions: ocrTransactionJson,
        duplicates: matched.duplicates ?? [],
        new_txns: matched.new_txns ?? ocrTransactionJson.map((_, i) => i),
      };
    } catch (e: any) {
      return NextResponse.json({
        error: `Duplicate detection failed: ${e?.message ?? "unknown"}`,
      }, { status: 502 });
    }
  } else {
    // PDF or paste-mode: ask the LLM to both extract + match in one shot
    const extractionPrompt = `You are a bank statement parser. The user has uploaded their bank statement (raw text below). Your job:

1. Extract ALL transactions as a JSON array. Each item: { date, description, amount, type, balance_after }
   - type: "debit" (money out) or "credit" (money in)
   - date: ISO date (YYYY-MM-DD) if parseable, else null
   - amount: number (always positive)
   - description: the description/memo from the statement
2. For each extracted txn, check if it matches an existing user txn (same amount ±5%, within ±3 days).
3. Return JSON: { transactions: [...], duplicates: [{extracted_index, existing_txn_id, existing_amount, existing_timestamp}], new_txns: [indices in transactions array that are NOT duplicates] }

Return ONLY the JSON, no commentary.

=== BANK STATEMENT TEXT ===
${rawText}

=== USER'S EXISTING TRANSACTIONS (last 90 days) ===
${JSON.stringify(existingSummary, null, 2)}`;

    try {
      const res = await chatComplete(config, [
        { role: "system", content: extractionPrompt },
        { role: "user", content: "Process the statement and return the JSON." },
      ], [], { forceJsonOutput: true });
      const jsonMatch = res.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return NextResponse.json({
          error: "LLM did not return valid JSON",
          raw: res.content.slice(0, 500),
        }, { status: 502 });
      }
      extracted = JSON.parse(jsonMatch[0]);
    } catch (e: any) {
      return NextResponse.json({
        error: `LLM extraction failed: ${e?.message ?? "unknown"}`,
      }, { status: 502 });
    }
  }

  // Step 4: for each new (non-duplicate) txn, log it using the agent's tools.
  // For each potential duplicate, return it for user review (don't auto-skip — let user decide).
  const newLogged: any[] = [];
  const duplicatesForReview: any[] = [];

  for (let i = 0; i < (extracted.transactions?.length ?? 0); i++) {
    const txn = extracted.transactions[i];
    if (!txn) continue;
    const dupInfo = extracted.duplicates?.find((d) => d.extracted_index === i);
    if (dupInfo) {
      // Potential duplicate — return for user review
      duplicatesForReview.push({
        extracted: {
          date: txn.date,
          description: txn.description,
          amount: txn.amount,
          type: txn.type,
        },
        existing_txn_id: dupInfo.existing_txn_id,
        existing_amount: dupInfo.existing_amount,
        existing_timestamp: dupInfo.existing_timestamp,
      });
    } else {
      // New — log it
      const args: Record<string, unknown> = {
        amount: Number(txn.amount),
        category: guessCategoryFromDescription(txn.description),
        notes: txn.description,
      };
      if (txn.date) {
        args.timestamp = `${txn.date}T12:00:00`;
      }
      const toolName = txn.type === "credit" ? "log_income" : "log_expense";
      const result = await dispatchTool(toolName, userId, args);
      newLogged.push({
        extracted: { date: txn.date, description: txn.description, amount: txn.amount, type: txn.type },
        result,
      });
    }
  }

  const sourceLabel = usedOcr ? "image (OCR)" : "statement";
  return NextResponse.json({
    summary: `Processed ${extracted.transactions?.length ?? 0} transactions from ${sourceLabel}. Logged ${newLogged.length} new. ${duplicatesForReview.length} potential duplicates flagged for review.${usedOcr ? " (OCR extraction)" : ""}`,
    total_extracted: extracted.transactions?.length ?? 0,
    new_logged: newLogged,
    duplicates_for_review: duplicatesForReview,
    used_ocr: usedOcr,
  });
}

/**
 * Heuristic category guesser from statement description.
 * Real categorization happens via the LLM in production; this is a fallback.
 */
function guessCategoryFromDescription(desc: string): string {
  const lower = (desc || "").toLowerCase();
  if (/upi|gpay|phonepe|paytm/.test(lower)) return "Transfer";
  if (/salary|payroll/.test(lower)) return "Salary";
  if (/food|restaurant|zomato|swiggy|dominos|mcdonald/.test(lower)) return "Food";
  if (/fuel|petrol|bpcl|hpcl|indianoil/.test(lower)) return "Transport";
  if (/amazon|flipkart|myntra/.test(lower)) return "Shopping";
  if (/electric|gas|water|broadband|mobile|bill/.test(lower)) return "Bills";
  if (/atm|cash/.test(lower)) return "Cash withdrawal";
  if (/interest/.test(lower)) return "Investment returns";
  return "Other";
}
