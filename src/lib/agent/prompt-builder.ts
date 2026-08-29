/**
 * System prompt assembly: takes the agent's base system prompt (from admin config)
 * and appends:
 * - Time injection (rendered from the admin's time template)
 * - Schema-in-context (user's accounts/contacts/investments as compact JSON —
 *   current BALANCES are always included, even in RAG mode)
 * - Last N transactions summary (for duplicate detection)
 * - Feature flag hints (e.g., "auto-append totals is OFF" so agent knows not to)
 * - Glossary (for dashboard agent only)
 * - Date-resolution rules so the agent computes from/to dates correctly for
 *   questions like "3 months ago how much did I send to him".
 */
import { db } from "@/lib/db";
import {
  getFeatureFlags,
  getSchemaMode,
  getGlossary,
  getTimeTemplate,
} from "@/lib/admin-config";

const DATE_RULES = `
=== DATE RESOLUTION RULES (IMPORTANT) ===
You ALWAYS know the exact current date from the CURRENT TIME section. For ANY question that mentions a time range — "3 months ago", "last week", "June", "from 1st to 15th", "kal", "pichle mahine" — COMPUTE concrete YYYY-MM-DD from_date / to_date values from the current date and pass them to your tools. Never guess vaguely: do the arithmetic.
Examples (assume today is 2026-08-29):
- "3 months ago how much money did I send to Rahul?" → from_date=2026-05-01, to_date=2026-05-31 (the month 3 months back) OR the exact day 2026-05-29 if they mean "exactly 3 months ago" — prefer the month interpretation unless the user is specific.
- "last 3 months" → from_date=2026-05-29, to_date=2026-08-29.
- "pichle mahine ka kharcha" → from_date=2026-07-01, to_date=2026-07-31.
- "this month so far" → from_date=2026-08-01, to_date=2026-08-29.
For logging: "aaj/today" = current date; "kal/yesterday" = current date − 1; "parso" = − 2. If the user mentions a time of day (e.g., "6 baje"), set the timestamp with that hour.
`;

export async function buildDailySystemPrompt(userId: string, basePrompt: string): Promise<string> {
  const [timeBlock, schemaBlock, recentTxnsBlock, flags, schemaMode] = await Promise.all([
    renderTimeTemplate(),
    buildSchemaInContext(userId),
    buildRecentTxnsSummary(userId),
    getFeatureFlags(),
    getSchemaMode(),
  ]);

  let prompt = basePrompt + "\n\n";
  prompt += "=== CURRENT TIME ===\n" + timeBlock + "\n\n";
  prompt += "=== YOUR SCHEMA (existing entities + CURRENT live balances) ===\n" + schemaBlock + "\n\n";
  // In RAG mode, don't dump all txns — instruct the agent to call retrieve_transactions on demand
  if (schemaMode.mode === "rag") {
    prompt += "=== RETRIEVAL MODE ACTIVE (RAG) ===\n";
    prompt += `Your context does NOT contain your full transaction history (but it DOES contain current balances above). To answer questions about past transactions, you MUST call the retrieve_transactions or query_transactions tool before answering. If you can't find the answer after one retrieval call, try a different query (different keywords).\n\n`;
  } else {
    prompt += "=== RECENT TRANSACTIONS (latest, for duplicate detection + quick questions) ===\n" + recentTxnsBlock + "\n\n";
    prompt += "=== RETRIEVAL HINT ===\nFor questions about older transactions (beyond those shown above), call retrieve_transactions or query_transactions with computed from_date/to_date.\n\n";
  }
  prompt += DATE_RULES + "\n";
  prompt += `=== FEATURE FLAGS ===\n`;
  prompt += `- autoAppendTotals: ${flags.autoAppendTotals ? "ON (the app appends today's + month's totals to each reply — do not repeat them yourself)" : "OFF (do not append totals)"}\n`;
  prompt += `- defaultLanguage: ${flags.defaultLanguage} (use English unless user explicitly asks otherwise)\n`;
  prompt += `- pdfUpload: ${flags.pdfUpload ? "ON" : "OFF"} (user can upload bank statement PDFs)\n`;
  prompt += `- ocr: ${flags.ocr ? "ON" : "OFF"} (user can upload receipt/statement images for vision-based extraction)\n`;

  prompt += "\n=== CHART OFFER (use freely for analytical answers) ===\n";
  prompt += "When the user asks a question with a visual answer (breakdowns, comparisons, trends, net worth vs debt, etc.), give the TEXTUAL answer with concrete numbers FIRST. Then, if a chart would help, append a single line in EXACTLY this format (no code block, nothing after it):\n";
  prompt += "[CHART:{\"type\":\"bar|line|pie\",\"title\":\"<short>\",\"data\":[{\"label\":\"<x>\",\"value\":<number>},...],\"xLabel\":\"<optional>\",\"yLabel\":\"<optional>\"}]\n";
  prompt += "The app detects this marker and shows a 'Show as chart' button. Only ONE marker per reply. Never use it for simple balance checks or single-number answers.\n";

  return prompt;
}

export async function buildDashboardSystemPrompt(userId: string, basePrompt: string): Promise<string> {
  const [timeBlock, schemaBlock, flags, glossary, schemaMode] = await Promise.all([
    renderTimeTemplate(),
    buildSchemaInContext(userId),
    getFeatureFlags(),
    getGlossary(),
    getSchemaMode(),
  ]);

  let prompt = basePrompt + "\n\n";
  prompt += "=== CURRENT TIME ===\n" + timeBlock + "\n\n";
  prompt += "=== YOUR SCHEMA (current live balances) ===\n" + schemaBlock + "\n\n";
  if (schemaMode.mode === "rag") {
    prompt += "=== RETRIEVAL MODE ACTIVE (RAG) ===\n";
    prompt += `Your context does NOT contain your full transaction history (but it DOES contain current balances above). To answer analytical questions:\n  1. For structured filters (date range, account, category, contact) — use query_transactions.\n  2. For semantic / natural-language queries (e.g., 'show me my food spend', 'rapido rides') — use retrieve_transactions.\n  3. For totals / breakdowns — use aggregate.\n  4. For current balances — use get_account_summary.\nAlways gather data FIRST, then answer with concrete numbers.\n\n`;
  } else {
    prompt += "=== RETRIEVAL HINT ===\nFor deeper historical queries beyond context, call retrieve_transactions or query_transactions with computed from_date/to_date.\n\n";
  }
  prompt += DATE_RULES + "\n";
  prompt += "=== FINANCE GLOSSARY ===\n";
  prompt += glossary.map((g) => `- ${g.term}: ${g.desc}`).join("\n") + "\n\n";
  prompt += `=== FEATURE FLAGS ===\n- defaultLanguage: ${flags.defaultLanguage}\n`;

  prompt += "=== DASHBOARD-SPECIFIC POWERS ===\n";
  prompt += "1. CHART OFFER: When the user asks an analytical question with a visual answer (breakdowns, trends, comparisons), give the TEXTUAL answer FIRST. Then, if a chart would help, append a single line in EXACTLY this format (no code block, no extra text after):\n";
  prompt += "[CHART:{\"type\":\"bar|line|pie\",\"title\":\"<short>\",\"data\":[{\"label\":\"<x>\",\"value\":<number>},...],\"xLabel\":\"<optional>\",\"yLabel\":\"<optional>\"}]\n";
  prompt += "The user's UI will detect this marker, show a 'Show as chart' button, and render the chart inline. Do NOT use the marker for questions that don't need a chart (e.g., 'what is my balance?'). Only ONE marker per reply.\n";
  prompt += "2. MINDMAP EDITS: When the user asks you to modify a mindmap, call propose_mindmap_edit. Use the SIMPLE node shape {id, label} and simple edge shape {source, target} — the server auto-assigns positions + types. Example: propose_mindmap_edit(id='mm123', summary='added 3 nodes', nodes=[{id:'r',label:'Budget'},{id:'i',label:'Income'},{id:'e',label:'Expenses'}], edges=[{source:'r',target:'i'},{source:'r',target:'e'}]). The UI will show a 'review + save' affordance — do NOT claim the mindmap is saved until the user clicks Save.\n";
  prompt += "3. EXPORTS: When the user asks to 'export my transactions as PDF' or 'CSV', call export_data with format + optional from_date/to_date. The tool returns a download URL you can present to the user.\n";

  return prompt;
}

async function renderTimeTemplate(): Promise<string> {
  const template = await getTimeTemplate();
  if (!template) return `Current datetime (IST): ${new Date().toISOString()}`;

  const now = new Date();
  // Format with IST offset
  const istFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "long",
  });
  const parts = istFormatter.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const now_ist = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} IST`;
  const date_ist = `${get("year")}-${get("month")}-${get("day")}`;
  const time_ist = `${get("hour")}:${get("minute")}:${get("second")}`;
  const weekday_ist = get("weekday");

  return template
    .replaceAll("{now_ist}", now_ist)
    .replaceAll("{date_ist}", date_ist)
    .replaceAll("{time_ist}", time_ist)
    .replaceAll("{weekday_ist}", weekday_ist)
    .replaceAll("{user_tz}", "Asia/Kolkata");
}

async function buildSchemaInContext(userId: string): Promise<string> {
  const schemaMode = await getSchemaMode();
  const [accounts, contacts, categories] = await Promise.all([
    db.account.findMany({ where: { userId, isActive: true } }),
    db.contact.findMany({ where: { userId } }),
    db.category.findMany({ where: { userId } }),
  ]);
  // CURRENT BALANCES are ALWAYS injected — the user can ask "how much do I
  // have in SBI" any time and get a live answer without a tool round-trip.
  const compact = {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, institution: a.institution, balance: a.balance })),
    contacts: contacts.map((c) => ({ id: c.id, name: c.name, type: c.type, balance: c.balance })),
    categories: categories.map((c) => ({ name: c.name, type: c.type })),
  };
  if (schemaMode.mode === "rag") {
    return (
      JSON.stringify(compact, null, 2) +
      `\n(Mode: RAG — transaction history is NOT in context; use query_transactions / retrieve_transactions / aggregate on demand. The balances above are live.)`
    );
  }
  return JSON.stringify(compact, null, 2);
}

async function buildRecentTxnsSummary(userId: string): Promise<string> {
  const schemaMode = await getSchemaMode();
  const take = Math.min(schemaMode.lastNTxns, 15);
  const txns = await db.transaction.findMany({
    where: { userId },
    orderBy: { timestamp: "desc" },
    take,
    include: { category: true, fromAccount: true, toAccount: true, contact: true },
  });
  if (txns.length === 0) return "(no transactions yet)";
  return txns
    .map((t) => {
      const parts = [
        t.timestamp.toISOString().slice(0, 16).replace("T", " "),
        t.type,
        `Rs ${t.amount}`,
        t.category?.name,
        t.fromAccount?.name,
        t.toAccount?.name,
        t.contact?.name,
        t.notes,
      ].filter(Boolean);
      return "- " + parts.join(" | ");
    })
    .join("\n");
}
