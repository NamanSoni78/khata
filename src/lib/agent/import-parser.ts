/**
 * Import parser — turns data produced by ANY external AI chatbot (following
 * public/addingaccountsprompt.md) into Khata entities.
 *
 * Accepted input formats (auto-detected):
 *   A. JSON      — { accounts:[...], contacts:[...], categories:[...] }
 *   B. Markdown  — "## Accounts" / "## Contacts" / "## Categories" sections
 *                  with pipe tables (the format addingaccountsprompt.md emits)
 *   C. CSV       — header row with a `name` column + `kind` column
 *                  (account|contact|category), comma/semicolon/tab separated
 *
 * Output is validated + normalized, then compared with the user's existing
 * entities to produce a conflict list for review before anything is applied.
 */

export interface ImportedAccount {
  name: string;
  type: string; // bank | demat | wallet | cash | investment | other
  institution?: string | null;
  balance: number;
  notes?: string | null;
}

export interface ImportedContact {
  name: string;
  type: string; // friend | family | colleague | merchant | other
  relationship?: string | null;
  balance: number; // + = they owe me, - = I owe them
  notes?: string | null;
}

export interface ImportedCategory {
  name: string;
  type: string; // expense | income | transfer | investment | loan
}

export interface ParsedImport {
  accounts: ImportedAccount[];
  contacts: ImportedContact[];
  categories: ImportedCategory[];
}

export interface ImportConflict {
  kind: "account" | "contact";
  name: string;
  existingId: string;
  existingValue: string; // human summary of what exists
  importedValue: string; // human summary of what's imported
  field: string; // main differing field, e.g. "balance"
}

const ACCOUNT_TYPES = ["bank", "demat", "wallet", "cash", "investment", "other"];
const CONTACT_TYPES = ["friend", "family", "colleague", "merchant", "other"];
const CATEGORY_TYPES = ["expense", "income", "transfer", "investment", "loan"];

/** Parse a money string: "₹1,25,000", "125000.50", "-500", "rs 20" → number. */
function parseMoney(s: unknown): number {
  if (typeof s === "number" && isFinite(s)) return s;
  if (s === null || s === undefined) return 0;
  const cleaned = String(s)
    .replace(/[₹$,\s]/g, "")
    .replace(/rs\.?/gi, "")
    .replace(/[()]/g, (m) => (m === "(" ? "-" : ""));
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}

function normType(s: unknown, allowed: string[], fallback: string): string {
  const v = String(s ?? "").toLowerCase().trim();
  // Partial matches: "savings bank" -> bank, "demat account" -> demat
  for (const a of allowed) if (v.includes(a)) return a;
  return fallback;
}

function str(s: unknown): string {
  return s === null || s === undefined ? "" : String(s).trim();
}

function nonEmpty(s: unknown): string | null {
  const v = str(s);
  return v.length > 0 && v !== "—" && v !== "-" ? v : null;
}

// ============================================================
//  Entry point
// ============================================================

export function parseImportContent(raw: string): ParsedImport {
  const input = (raw ?? "").trim();
  if (!input) return { accounts: [], contacts: [], categories: [] };

  // 1. Direct JSON?
  if (input.startsWith("{") || input.startsWith("[")) {
    try {
      return normalizeJson(JSON.parse(input));
    } catch { /* fall through */ }
  }

  // 2. Extract fenced code blocks — the other AI puts the payload there.
  const blocks: string[] = [];
  const fenceRe = /```[a-zA-Z]*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(input)) !== null) blocks.push(m[1]);

  // If any block is pure JSON, prefer it.
  for (const b of blocks) {
    const t = b.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return normalizeJson(JSON.parse(t));
      } catch { /* try next */ }
    }
  }

  // 3. Markdown tables (search the whole input + blocks).
  const mdSource = blocks.length > 0 ? blocks.join("\n\n") : input;
  const md = parseMarkdownSections(mdSource);
  if (md.accounts.length + md.contacts.length + md.categories.length > 0) return md;

  // 4. CSV fallback.
  return parseCsv(mdSource);
}

// ============================================================
//  JSON normalizer
// ============================================================

function normalizeJson(data: any): ParsedImport {
  const root = Array.isArray(data) ? { items: data } : data ?? {};
  const src = root.items && !root.accounts ? { accounts: root.items.filter((i: any) => !i.kind || i.kind === "account"), contacts: root.items.filter((i: any) => i.kind === "contact"), categories: root.items.filter((i: any) => i.kind === "category") } : root;

  const accounts: ImportedAccount[] = (src.accounts ?? [])
    .filter((a: any) => nonEmpty(a?.name))
    .map((a: any) => ({
      name: str(a.name).slice(0, 80),
      type: normType(a.type, ACCOUNT_TYPES, "bank"),
      institution: nonEmpty(a.institution),
      balance: parseMoney(a.balance),
      notes: nonEmpty(a.notes),
    }));

  const contacts: ImportedContact[] = (src.contacts ?? [])
    .filter((c: any) => nonEmpty(c?.name))
    .map((c: any) => ({
      name: str(c.name).slice(0, 80),
      type: normType(c.type, CONTACT_TYPES, "friend"),
      relationship: nonEmpty(c.relationship),
      balance: parseMoney(c.balance),
      notes: nonEmpty(c.notes),
    }));

  const categories: ImportedCategory[] = (src.categories ?? [])
    .filter((c: any) => nonEmpty(c?.name))
    .map((c: any) => ({
      name: str(c.name).slice(0, 60),
      type: normType(c.type, CATEGORY_TYPES, "expense"),
    }));

  return { accounts, contacts, categories };
}

// ============================================================
//  Markdown pipe-table parser (section-aware)
// ============================================================

function parseMarkdownSections(md: string): ParsedImport {
  const out: ParsedImport = { accounts: [], contacts: [], categories: [] };

  // Split into "## <Title>" sections
  const sectionRe = /^#{1,3}\s*(.+)$/gm;
  const marks: Array<{ title: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(md)) !== null) {
    marks.push({ title: m[1].toLowerCase(), start: m.index });
  }

  const section = (i: number) => md.slice(marks[i].start, i + 1 < marks.length ? marks[i + 1].start : md.length);

  for (let i = 0; i < marks.length; i++) {
    const title = marks[i].title;
    const body = section(i);
    if (/account|bank|wallet|demat/.test(title)) out.accounts.push(...parseTable(body, "account"));
    else if (/contact|people|friend|person/.test(title)) out.contacts.push(...parseTable(body, "contact"));
    else if (/categor/.test(title)) out.categories.push(...parseTable(body, "category"));
  }

  // Fallback: no recognized section headers — scan all tables and classify by columns
  if (out.accounts.length + out.contacts.length + out.categories.length === 0) {
    const tables = md.split(/\n(?=\|)/);
    for (const t of tables) {
      const header = (t.match(/^\|(.+)\|?/) ?? [])[1] ?? "";
      const h = header.toLowerCase();
      if (h.includes("institution") || h.includes("balance") && h.includes("type")) {
        out.accounts.push(...parseTable(t, "account"));
      } else if (h.includes("relationship") || h.includes("owes")) {
        out.contacts.push(...parseTable(t, "contact"));
      }
    }
  }

  return out;
}

function parseTable(block: string, kind: "account" | "contact" | "category"): any[] {
  const lines = block.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return [];

  // Header row -> column keys
  const cells = (l: string) =>
    l.split("|").slice(1, l.trim().endsWith("|") ? -1 : undefined).map((c) => c.trim());
  const header = cells(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));

  const findCol = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));

  const rows: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Skip separator rows like |---|---|
    if (/^\|[\s\-:|]+\|?$/.test(line.trim())) continue;
    const vals = cells(line);
    if (vals.length === 0 || !vals[0]) continue;

    const name = vals[findCol("name")] ?? vals[0];
    if (!name || name.toLowerCase() === "name") continue;

    if (kind === "account") {
      rows.push({
        name,
        type: vals[findCol("type")] ?? "bank",
        institution: vals[findCol("institution", "bank")] ?? null,
        balance: parseMoney(vals[findCol("balance")] ?? "0"),
        notes: vals[findCol("note")] ?? null,
      });
    } else if (kind === "contact") {
      rows.push({
        name,
        type: vals[findCol("type")] ?? "friend",
        relationship: vals[findCol("relationship")] ?? null,
        balance: parseMoney(vals[findCol("balance", "owe")] ?? "0"),
        notes: vals[findCol("note")] ?? null,
      });
    } else {
      rows.push({
        name,
        type: vals[findCol("type")] ?? "expense",
      });
    }
  }
  return rows;
}

// ============================================================
//  CSV parser (single flat table with a kind column)
// ============================================================

function parseCsv(text: string): ParsedImport {
  const out: ParsedImport = { accounts: [], contacts: [], categories: [] };
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return out;

  const delim = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(delim).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  if (!header.includes("name")) return out;

  const col = (names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(delim).map((v) => v.trim().replace(/^"|"$/g, ""));
    const name = vals[col(["name"])] ?? vals[0];
    if (!name) continue;
    const kindRaw = (vals[col(["kind", "entity"])] ?? "account").toLowerCase();
    if (kindRaw.startsWith("categor")) {
      out.categories.push({ name, type: normType(vals[col(["type"])], CATEGORY_TYPES, "expense") });
    } else if (kindRaw.startsWith("contact") || kindRaw.startsWith("person") || kindRaw.startsWith("friend")) {
      out.contacts.push({
        name,
        type: normType(vals[col(["type"])], CONTACT_TYPES, "friend"),
        relationship: vals[col(["relationship"])] ?? null,
        balance: parseMoney(vals[col(["balance", "owe"])] ?? "0"),
        notes: vals[col(["note"])] ?? null,
      });
    } else {
      out.accounts.push({
        name,
        type: normType(vals[col(["type"])], ACCOUNT_TYPES, "bank"),
        institution: vals[col(["institution", "bank"])] ?? null,
        balance: parseMoney(vals[col(["balance"])] ?? "0"),
        notes: vals[col(["note"])] ?? null,
      });
    }
  }
  return out;
}

// ============================================================
//  Conflict detection (parsed import vs existing user data)
// ============================================================

export async function detectConflicts(userId: string, parsed: ParsedImport, existing: {
  accounts: Array<{ id: string; name: string; balance: number; type: string; institution: string | null }>;
  contacts: Array<{ id: string; name: string; balance: number; type: string }>;
}): Promise<ImportConflict[]> {
  const conflicts: ImportConflict[] = [];

  const accByName = new Map(existing.accounts.map((a) => [a.name.toLowerCase(), a]));
  for (const a of parsed.accounts) {
    const ex = accByName.get(a.name.toLowerCase());
    if (ex) {
      const balanceDiffers = Math.abs((ex.balance ?? 0) - a.balance) > 0.01;
      const typeDiffers = ex.type !== a.type;
      if (balanceDiffers || typeDiffers) {
        conflicts.push({
          kind: "account",
          name: ex.name,
          existingId: ex.id,
          field: balanceDiffers ? "balance" : "type",
          existingValue: `${ex.type} · balance ₹${ex.balance.toLocaleString("en-IN")}`,
          importedValue: `${a.type} · balance ₹${a.balance.toLocaleString("en-IN")}`,
        });
      }
    }
  }

  const conByName = new Map(existing.contacts.map((c) => [c.name.toLowerCase(), c]));
  for (const c of parsed.contacts) {
    const ex = conByName.get(c.name.toLowerCase());
    if (ex) {
      const balanceDiffers = Math.abs((ex.balance ?? 0) - c.balance) > 0.01;
      if (balanceDiffers) {
        conflicts.push({
          kind: "contact",
          name: ex.name,
          existingId: ex.id,
          field: "balance",
          existingValue: `balance ${ex.balance >= 0 ? "+" : "−"}₹${Math.abs(ex.balance).toLocaleString("en-IN")}`,
          importedValue: `balance ${c.balance >= 0 ? "+" : "−"}₹${Math.abs(c.balance).toLocaleString("en-IN")}`,
        });
      }
    }
  }

  return conflicts;
}
