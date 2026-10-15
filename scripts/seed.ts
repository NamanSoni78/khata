/**
 * Seed script — initializes AdminConfig defaults + default categories.
 * Safe to re-run; upserts each AdminConfig key.
 *
 * Run: bun run db:seed
 */
import { db } from "../src/lib/db";
import bcrypt from "bcryptjs";
import { DEFAULT_CATEGORIES } from "../src/lib/agent/default-categories";
export { DEFAULT_CATEGORIES };

// ============================================================
//  DEFAULT AGENT CONFIGS
// ============================================================

interface AgentConfig {
  provider: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokensMode: "max_tokens" | "max_completion_tokens";
  maxTokens: number;
  toolCallingSupported: boolean;
  systemPrompt: string;
  extraHeaders?: string;
}

const DEFAULT_DAILY_AGENT: AgentConfig = {
  provider: "openai-compatible",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKey: "", // admin must set their API key in /admin
  model: "llama-3.3-70b-versatile",
  temperature: 0.4,
  maxTokensMode: "max_tokens",
  maxTokens: 2000, // bumped from 800 to handle multi-leg scenarios with 3-4 tool calls
  toolCallingSupported: true,
  systemPrompt: `You are Khata — a personal finance assistant for an Indian user. You help them log daily transactions AND answer questions about their money, all in one chat.

CORE BEHAVIOR:
- User speaks in Hinglish/Hindi/English mixed. Understand all three.
- ALWAYS respond in English unless user explicitly asks for Hinglish/Hindi.
- Keep replies SHORT (1-2 sentences) for logging confirmations. You're a daily-use chat, not a lecture.
- For analytical questions ("how much did I spend on food", "what's my net worth", "3 months ago how much did I send to Rahul") — gather data with tools FIRST, then answer with concrete numbers.

TOOL CALLING:
- You MUST call a tool for ANY transaction logging action. Do NOT just write "Logged Rs X for Y." as text — you MUST emit the actual tool call.
- After a successful tool call result, your final reply should be very short, e.g., "Logged Rs 20 for Transport."
- If information is ambiguous or missing, call ask_clarification with a specific question.
- If a transaction sounds similar to a recent one in context, ASK before logging to prevent duplicates.
- When the user references something from an OLD conversation that isn't in your recent context, use search_chat_history to find it.

CURRENCY: INR only. Use "Rs" or "₹" (e.g., Rs 20, Rs 2,000, Rs 30,000).

WHEN TO USE TOOLS:
- log_expense: when user describes spending money (rapido, food, rent, etc.). Include contact + account if mentioned — they'll be auto-created if new.
- log_income: when user describes receiving money (salary, refund, gift, repayment received)
- log_transfer: when user moves money between their own accounts (not to/from a contact)
- create_account / create_contact: when user explicitly introduces a new account/person not in schema
- ask_clarification: when needed info is genuinely ambiguous (e.g., "2000 diye" — gave or received?)
- mark_event: non-financial events in a sequence (e.g., "IPO got selected", "SIP completed")
- link_transactions: when you realize AFTER logging that some txns should be grouped
- retrieve_transactions / query_transactions / aggregate / get_account_summary: for ANY question about past transactions, totals, balances, or trends. COMPUTE from_date/to_date from the current date for every relative-time question.
- create_scheduled_notification: for reminders — "remind me at 8pm daily", "9:10pm daily with my day's totals", "next Monday 6am". Pass structured fields (type/time/days/date), never cron strings. Placeholders {today_income} {today_expense} {month_income} {month_expense} render live totals in the notification.
- export_data: when user wants a CSV/PDF export

MULTI-LEG / COMPLEX SCENARIOS:
When a single user message describes a multi-step money flow, log EACH leg separately with the SAME group_label so they're linked. Example:
  User: "Rahul ne 30k diye IPO ke liye SBI mein, pichle baar ka IPO profit 10k PNB mein aaya"
  Legs (all with group_label="Rahul IPO plan"):
    1. log_income(amount=30000, contact=Rahul, account=SBI, category=Loan repayment received, notes="for IPO")
    2. log_expense(amount=30000, from_account=SBI, category=IPO investment, notes="SBI IPO application")
    3. log_income(amount=10000, account=PNB, category=Investment returns, notes="previous IPO profit")
  Final reply: brief summary like "Logged 3 legs of Rahul IPO plan: +Rs 30k from Rahul to SBI, -Rs 30k IPO investment, +Rs 10k profit to PNB."

CONTEXT:
- Current date/time is injected every call. Use it to interpret "today", "yesterday", "kal", "aaj", "3 months ago" — the DATE RESOLUTION RULES section shows exactly how to compute from_date/to_date.
- The user's accounts, contacts and their CURRENT LIVE balances are in the schema section. Answer balance questions directly from it, or call get_account_summary for a fresh snapshot.

MARKDOWN: You may format replies with markdown (**bold**, lists) — it renders in the chat.

DO NOT lecture. DO NOT add advice unless asked. DO NOT append today's totals unless the admin flag says to.`,
};

const DEFAULT_DASHBOARD_AGENT: AgentConfig = {
  provider: "openai-compatible",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKey: "", // admin must set their API key in /admin
  model: "llama-3.3-70b-versatile",
  temperature: 0.5,
  maxTokensMode: "max_tokens",
  maxTokens: 4000,
  toolCallingSupported: true,
  systemPrompt: `You are a financial analysis assistant for an Indian user. The user accesses you from their dashboard to analyze their finances weekly/monthly.

CORE BEHAVIOR:
- Understand Hinglish/Hindi/English. Respond in English unless explicitly asked for Hinglish.
- Be more thorough here than the daily chat — this is the deep-dive surface.
- You have access to ALL the user's transactions, accounts, contacts, and metadata via tools.
- When user asks a question that needs analysis, gather data first, then answer with specific numbers.
- When your answer would benefit from a chart, at the END of your reply add: "Want me to show this as a chart?" — the UI will render a "Show as chart" button.
- Use the FINANCE GLOSSARY provided in context to disambiguate terms (IPO, SIP, FD, RD, MF, demat, etc.).

RESPONSIBILITIES:
- Monthly expense/income analysis with category breakdowns
- Budget planning and tracking
- Investment profit/loss (per-account, per-investment-type)
- Cross-account comparisons (e.g., "which demat has highest return this quarter")
- "What-if" scenarios (e.g., "if I keep 20% of the IPO profit, how much is left?")
- Setting scheduled notifications (use create_scheduled_notification tool)
- Exporting data (use export_data tool with format + date range)

WHEN TO USE TOOLS:
- query_transactions: filter + retrieve transactions by date/account/category/contact
- aggregate: get sums/averages grouped by dimension
- get_account_summary: snapshot of all accounts with balances + recent activity
- create_scheduled_notification: set up recurring or one-time reminders
- export_data: trigger a CSV/PDF export job

Always answer with concrete numbers, not vague statements. If data is missing, say so.`,
};

const DEFAULT_STT_AGENT: AgentConfig & { engine: "native" | "openai-compatible" } = {
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "whisper-1",
  temperature: 0,
  maxTokensMode: "max_tokens",
  maxTokens: 0,
  toolCallingSupported: false,
  engine: "native",
  systemPrompt: "",
};

const DEFAULT_OCR_AGENT: AgentConfig & { enabled: boolean } = {
  // OCR requires a vision-capable model. Admin must configure one in /admin:
  //   - OpenAI gpt-4o (recommended; default below)
  //   - Anthropic claude-3-5-sonnet
  //   - Groq llama-3.2-90b-vision-preview
  //   - OpenRouter / Google Gemini 1.5 Pro / etc.
  provider: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o",
  temperature: 0,
  maxTokensMode: "max_tokens",
  maxTokens: 4000,
  toolCallingSupported: false,
  enabled: false, // admin must explicitly turn ON via feature flag + agent enabled flag
  systemPrompt: `You are an OCR + extraction agent. Given a bank statement image, extract all transactions as a JSON array. Each item: { date, description, amount, type, balance_after }. Return ONLY the JSON: { "transactions": [...] }, no commentary.`,
};

// ============================================================
//  DEFAULT FEATURE FLAGS
// ============================================================

const DEFAULT_FEATURE_FLAGS = {
  pdfUpload: true,
  ocr: false,
  sttNative: true,
  webPush: false,
  autoAppendTotals: false,
  defaultLanguage: "english",
};

// ============================================================
//  DEFAULT TIME-INJECTION TEMPLATE
// ============================================================

const DEFAULT_TIME_TEMPLATE = `Current datetime (IST): {now_ist}
Current date: {date_ist}
Current time: {time_ist}
Day of week: {weekday_ist}
User timezone: {user_tz}`;

// ============================================================
//  DEFAULT SCHEMA-IN-CONTEXT MODE
// ============================================================

const DEFAULT_SCHEMA_MODE = {
  mode: "llm",
  lastNTxns: 50,
  refreshEveryCall: true,
  chatHistoryLimit: 24, // recent chat messages fed to the LLM per call (older ones stay searchable via search_chat_history)
};

// ============================================================
//  DEFAULT UX CONFIG (admin-tunable chat behaviour)
// ============================================================

const DEFAULT_UX_CONFIG = {
  replyDelayMs: 0, // optional artificial minimum delay before a chat reply returns (0 = off)
};

// ============================================================
//  FINANCE GLOSSARY (50+ terms)
// ============================================================

const DEFAULT_GLOSSARY = [
  { term: "IPO", desc: "Initial Public Offering — first sale of shares to public" },
  { term: "SIP", desc: "Systematic Investment Plan — periodic mutual fund investment" },
  { term: "FD", desc: "Fixed Deposit — bank deposit with fixed term and interest" },
  { term: "RD", desc: "Recurring Deposit — monthly fixed deposit" },
  { term: "MF", desc: "Mutual Fund — pooled investment vehicle" },
  { term: "Demat", desc: "Dematerialized account — holds shares electronically" },
  { term: "ULIP", desc: "Unit Linked Insurance Plan — insurance + investment" },
  { term: "NPS", desc: "National Pension System — retirement savings" },
  { term: "PPF", desc: "Public Provident Fund — 15-year govt savings" },
  { term: "EPF", desc: "Employee Provident Fund — salary-deducted retirement savings" },
  { term: "ELSS", desc: "Equity Linked Savings Scheme — tax-saving MF" },
  { term: "ETF", desc: "Exchange Traded Fund — index-tracking stock" },
  { term: "Bond", desc: "Debt instrument — issuer owes holder a debt" },
  { term: "Debenture", desc: "Unsecured corporate debt instrument" },
  { term: "Equity", desc: "Stock/shares representing ownership" },
  { term: "Dividend", desc: "Profit distribution to shareholders" },
  { term: "Bonus share", desc: "Free additional shares given to existing holders" },
  { term: "Rights issue", desc: "Offer to existing shareholders to buy new shares" },
  { term: "Buyback", desc: "Company repurchases its own shares" },
  { term: "Stock split", desc: "Dividing existing shares into multiple" },
  { term: "CAGR", desc: "Compound Annual Growth Rate" },
  { term: "XIRR", desc: "Extended Internal Rate of Return — for irregular cashflows" },
  { term: "NAV", desc: "Net Asset Value — per-unit price of MF" },
  { term: "AUM", desc: "Assets Under Management" },
  { term: "Expense ratio", desc: "Annual MF fee as % of AUM" },
  { term: "Exit load", desc: "Fee for early MF withdrawal" },
  { term: "Lump sum", desc: "One-time investment (vs SIP)" },
  { term: "STCG", desc: "Short-Term Capital Gain" },
  { term: "LTCG", desc: "Long-Term Capital Gain" },
  { term: "Capital gain", desc: "Profit from selling a capital asset" },
  { term: "Capital loss", desc: "Loss from selling a capital asset" },
  { term: "Indexation", desc: "Inflation adjustment for capital gains tax" },
  { term: "Holding period", desc: "Time an asset is held before selling" },
  { term: "Demat account", desc: "Electronic share-holding account" },
  { term: "Trading account", desc: "Account to buy/sell securities" },
  { term: "Brokerage", desc: "Fee charged by broker per trade" },
  { term: "Margin", desc: "Money borrowed from broker to trade" },
  { term: "Short selling", desc: "Selling shares you don't own" },
  { term: "Futures", desc: "Derivative contract to buy/sell at future date" },
  { term: "Options", desc: "Right but not obligation to buy/sell at strike" },
  { term: "Call option", desc: "Right to buy at strike price" },
  { term: "Put option", desc: "Right to sell at strike price" },
  { term: "Strike price", desc: "Pre-agreed price in option contract" },
  { term: "Premium", desc: "Price paid for an option contract" },
  { term: "Lot size", desc: "Number of units in one derivatives contract" },
  { term: "Stop loss", desc: "Auto-sell trigger to limit losses" },
  { term: "Bull market", desc: "Rising market trend" },
  { term: "Bear market", desc: "Falling market trend" },
  { term: "Sensex", desc: "BSE 30-stock index" },
  { term: "Nifty", desc: "NSE 50-stock index" },
  { term: "Bank Nifty", desc: "NSE index of banking stocks" },
  { term: "Mid cap", desc: "Mid-sized companies (rank 101-250)" },
  { term: "Small cap", desc: "Small companies (rank 251+)" },
  { term: "Large cap", desc: "Top 100 companies by market cap" },
  { term: "Gold bond", desc: "Sovereign Gold Bond — govt gold investment" },
  { term: "Insurance premium", desc: "Amount paid for insurance cover" },
  { term: "EMI", desc: "Equated Monthly Installment on loans" },
  { term: "Principal", desc: "Original loan amount (vs interest)" },
  { term: "Interest", desc: "Cost of borrowing money" },
  { term: "Credit card", desc: "Revolving credit card" },
  { term: "Debit card", desc: "Card linked to bank account" },
  { term: "UPI", desc: "Unified Payments Interface — instant bank transfer" },
  { term: "NEFT", desc: "National Electronic Funds Transfer" },
  { term: "RTGS", desc: "Real-Time Gross Settlement (large amounts)" },
  { term: "IMPS", desc: "Immediate Payment Service — 24x7" },
];

// (DEFAULT_CATEGORIES imported from src/lib/agent/default-categories.ts)

// ============================================================
//  SEED FUNCTION
// ============================================================

export async function seed() {
  console.log("Seeding AdminConfig defaults...");

  const configs: Array<[string, unknown]> = [
    ["agent.daily", DEFAULT_DAILY_AGENT],
    ["agent.dashboard", DEFAULT_DASHBOARD_AGENT],
    ["agent.stt", DEFAULT_STT_AGENT],
    ["agent.ocr", DEFAULT_OCR_AGENT],
    ["featureFlags", DEFAULT_FEATURE_FLAGS],
    ["timeTemplate", DEFAULT_TIME_TEMPLATE],
    ["schemaMode", DEFAULT_SCHEMA_MODE],
    ["uxConfig", DEFAULT_UX_CONFIG],
    ["glossary", DEFAULT_GLOSSARY],
  ];

  for (const [key, value] of configs) {
    await db.adminConfig.upsert({
      where: { key },
      update: { value: JSON.stringify(value) }, // overwrite so re-seeding refreshes defaults
      create: { key, value: JSON.stringify(value) },
    });
    console.log(`  + ${key}`);
  }

  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminUsername && adminPassword) {
    console.log(`  i ADMIN_USERNAME=${adminUsername} detected. /admin route protected by env vars.`);
  } else {
    console.log("  i No ADMIN_USERNAME/ADMIN_PASSWORD env vars set. /admin route still env-authenticated.");
  }

  console.log("Seed complete.");
}

// Run directly (`bun run scripts/seed.ts`); imported as a module by
// turso-setup.ts (import.meta.main is Bun's "executed directly" flag).
if (import.meta.main) {
  seed()
    .catch((e) => {
      console.error("Seed failed:", e);
      process.exit(1);
    })
    .finally(async () => {
      await db.$disconnect();
    });
}
