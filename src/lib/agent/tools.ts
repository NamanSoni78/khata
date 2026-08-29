/**
 * Tool implementations for the finance agent.
 * Each takes (userId, args) and returns a string result for the LLM.
 */
import { db } from "@/lib/db";

type Args = Record<string, unknown>;

// Helper: fuzzy-find an account by name (case-insensitive substring). Auto-creates if not found (liquid schema).
async function findAccount(userId: string, name: string | undefined): Promise<{ id: string; name: string; type: string; institution: string | null; isNew?: boolean } | null> {
  if (!name) return null;
  const accounts = await db.account.findMany({ where: { userId, isActive: true } });
  const lower = name.toLowerCase().trim();
  const found = (
    accounts.find((a) => a.name.toLowerCase() === lower) ??
    accounts.find((a) => a.name.toLowerCase().includes(lower)) ??
    accounts.find((a) => lower.includes(a.name.toLowerCase())) ??
    null
  );
  if (found) return found;
  // Auto-create (liquid schema): create a generic bank account named after the input
  const created = await db.account.create({
    data: {
      userId,
      name, // store as-given (e.g., "SBI")
      type: "bank", // default to bank; user can correct later
      institution: name, // use the input as institution hint
    },
  });
  return { ...created, isNew: true };
}

async function findContact(userId: string, name: string | undefined): Promise<{ id: string; name: string; type: string; isNew?: boolean } | null> {
  if (!name) return null;
  const contacts = await db.contact.findMany({ where: { userId } });
  const lower = name.toLowerCase().trim();
  const found = (
    contacts.find((c) => c.name.toLowerCase() === lower) ??
    contacts.find((c) => c.name.toLowerCase().includes(lower)) ??
    null
  );
  if (found) return found;
  // Auto-create (liquid schema)
  const created = await db.contact.create({
    data: { userId, name, type: "friend" }, // default; user can correct later
  });
  return { ...created, isNew: true };
}

async function findOrCreateCategory(userId: string, name: string, fallbackType: string = "expense") {
  const lower = name.toLowerCase().trim();
  const existing = await db.category.findFirst({ where: { userId, name: { contains: name } } });
  if (existing) return existing;
  return db.category.create({
    data: { userId, name, type: fallbackType },
  });
}

// Helper: find-or-create a TransactionGroup by label for multi-leg linking
async function findOrCreateGroup(userId: string, label: string | undefined): Promise<string | undefined> {
  if (!label) return undefined;
  const lower = label.toLowerCase().trim();
  const existing = await db.transactionGroup.findFirst({
    where: { userId, label: { contains: label } },
  });
  if (existing) return existing.id;
  const created = await db.transactionGroup.create({
    data: { userId, label, description: null },
  });
  return created.id;
}

// ============================================================
//  LOG EXPENSE
// ============================================================

export async function logExpense(userId: string, args: Args): Promise<string> {
  const amount = Number(args.amount);
  if (!amount || amount <= 0) return "Error: invalid amount";
  const category = String(args.category);
  // Accept both `account` and `from_account` (LLM sometimes uses either)
  const accountName = (args.account as string | undefined) ?? (args.from_account as string | undefined);
  const account = await findAccount(userId, accountName);
  const contact = await findContact(userId, args.contact as string | undefined);
  const cat = await findOrCreateCategory(userId, category, "expense");
  const groupId = await findOrCreateGroup(userId, args.group_label as string | undefined);
  const timestamp = args.timestamp ? new Date(args.timestamp as string) : new Date();

  const txn = await db.transaction.create({
    data: {
      userId,
      type: "expense",
      amount,
      fromAccountId: account?.id,
      contactId: contact?.id,
      categoryId: cat.id,
      groupId,
      timestamp,
      notes: (args.notes as string) ?? null,
      source: "chat",
      status: "confirmed",
      metadata: JSON.stringify({ rawText: args.notes ?? "", groupLabel: args.group_label ?? null }),
    },
  });

  if (account) {
    await db.account.update({
      where: { id: account.id },
      data: { balance: { decrement: amount } },
    });
  }
  if (contact) {
    // I gave money TO contact → they owe me more → balance INCREMENT (positive = they owe me)
    await db.contact.update({
      where: { id: contact.id },
      data: { balance: { increment: amount } },
    });
  }

  const newAccountNote = account?.isNew ? ` (auto-created new account "${account.name}")` : "";
  const newContactNote = contact?.isNew ? ` (auto-created new contact "${contact.name}")` : "";
  const groupNote = groupId ? ` [group: ${args.group_label}]` : "";
  return `Logged expense of Rs ${amount} for "${category}"${account ? ` from ${account.name}` : ""}${contact ? ` (to ${contact.name})` : ""}.${newAccountNote}${newContactNote}${groupNote} Txn ID: ${txn.id}`;
}

// ============================================================
//  LOG INCOME
// ============================================================

export async function logIncome(userId: string, args: Args): Promise<string> {
  const amount = Number(args.amount);
  if (!amount || amount <= 0) return "Error: invalid amount";
  const category = String(args.category);
  const account = await findAccount(userId, args.account as string | undefined);
  const contact = await findContact(userId, args.contact as string | undefined);
  const cat = await findOrCreateCategory(userId, category, "income");
  const groupId = await findOrCreateGroup(userId, args.group_label as string | undefined);
  const timestamp = args.timestamp ? new Date(args.timestamp as string) : new Date();

  const txn = await db.transaction.create({
    data: {
      userId,
      type: "income",
      amount,
      toAccountId: account?.id,
      contactId: contact?.id,
      categoryId: cat.id,
      groupId,
      timestamp,
      notes: (args.notes as string) ?? null,
      source: "chat",
      status: "confirmed",
    },
  });

  if (account) {
    await db.account.update({
      where: { id: account.id },
      data: { balance: { increment: amount } },
    });
  }
  if (contact) {
    // I received money FROM contact → I owe them more → balance DECREMENT (negative = I owe them)
    await db.contact.update({
      where: { id: contact.id },
      data: { balance: { decrement: amount } },
    });
  }

  const newAccountNote = account?.isNew ? ` (auto-created new account "${account.name}")` : "";
  const newContactNote = contact?.isNew ? ` (auto-created new contact "${contact.name}")` : "";
  const groupNote = groupId ? ` [group: ${args.group_label}]` : "";
  return `Logged income of Rs ${amount} for "${category}"${account ? ` to ${account.name}` : ""}${contact ? ` (from ${contact.name})` : ""}.${newAccountNote}${newContactNote}${groupNote} Txn ID: ${txn.id}`;
}

// ============================================================
//  LOG TRANSFER (between own accounts)
// ============================================================

export async function logTransfer(userId: string, args: Args): Promise<string> {
  const amount = Number(args.amount);
  if (!amount || amount <= 0) return "Error: invalid amount";
  const fromAcc = await findAccount(userId, args.from_account as string);
  const toAcc = await findAccount(userId, args.to_account as string);
  if (!fromAcc || !toAcc) {
    return `Error: could not find both accounts. Found from: ${fromAcc?.name ?? "none"}, to: ${toAcc?.name ?? "none"}.`;
  }
  const groupId = await findOrCreateGroup(userId, args.group_label as string | undefined);
  const timestamp = args.timestamp ? new Date(args.timestamp as string) : new Date();

  const txn = await db.transaction.create({
    data: {
      userId,
      type: "transfer",
      amount,
      fromAccountId: fromAcc.id,
      toAccountId: toAcc.id,
      groupId,
      timestamp,
      notes: (args.notes as string) ?? null,
      source: "chat",
      status: "confirmed",
    },
  });
  await db.account.update({
    where: { id: fromAcc.id },
    data: { balance: { decrement: amount } },
  });
  await db.account.update({
    where: { id: toAcc.id },
    data: { balance: { increment: amount } },
  });

  const groupNote = groupId ? ` [group: ${args.group_label}]` : "";
  return `Logged transfer of Rs ${amount} from ${fromAcc.name} to ${toAcc.name}.${groupNote} Txn ID: ${txn.id}`;
}

// ============================================================
//  CREATE ACCOUNT
// ============================================================

export async function createAccount(userId: string, args: Args): Promise<string> {
  const name = String(args.name);
  const type = String(args.type);
  const institution = (args.institution as string) ?? null;
  const openingBalance = Number(args.opening_balance ?? 0);

  const existing = await db.account.findFirst({ where: { userId, name: { equals: name } } });
  if (existing) {
    return `Account "${name}" already exists with balance Rs ${existing.balance}.`;
  }

  const acc = await db.account.create({
    data: {
      userId,
      name,
      type,
      institution,
      balance: openingBalance,
    },
  });

  // If opening balance > 0, also log an opening balance income txn
  if (openingBalance > 0) {
    await db.transaction.create({
      data: {
        userId,
        type: "income",
        amount: openingBalance,
        toAccountId: acc.id,
        timestamp: new Date(),
        notes: `Opening balance for ${name}`,
        source: "agent_inferred",
        status: "confirmed",
      },
    });
  }

  return `Created new ${type} account "${name}"${institution ? ` at ${institution}` : ""} with opening balance Rs ${openingBalance}.`;
}

// ============================================================
//  CREATE CONTACT
// ============================================================

export async function createContact(userId: string, args: Args): Promise<string> {
  const name = String(args.name);
  const type = String(args.type);
  const relationship = (args.relationship as string) ?? null;

  const existing = await db.contact.findFirst({ where: { userId, name: { equals: name } } });
  if (existing) {
    return `Contact "${name}" already exists. Current balance: Rs ${existing.balance}.`;
  }

  const c = await db.contact.create({
    data: { userId, name, type, relationship, balance: 0 },
  });
  return `Created new ${type} contact "${name}"${relationship ? ` (${relationship})` : ""}. ID: ${c.id}`;
}

// ============================================================
//  ASK CLARIFICATION
// ============================================================

export async function askClarification(userId: string, args: Args): Promise<string> {
  const question = String(args.question);
  const context = (args.context as string) ?? "{}";

  await db.pendingQuestion.create({
    data: { userId, question, context, status: "open" },
  });

  // The agent's text reply IS the question. We return this so the LLM knows the tool was called.
  return `Asked clarification: ${question}`;
}

// ============================================================
//  DASHBOARD TOOLS
// ============================================================

export async function queryTransactions(userId: string, args: Args): Promise<string> {
  const where: any = { userId };
  if (args.from_date || args.to_date) {
    where.timestamp = {};
    if (args.from_date) where.timestamp.gte = new Date(args.from_date as string);
    if (args.to_date) {
      const t = new Date(args.to_date as string);
      t.setHours(23, 59, 59, 999);
      where.timestamp.lte = t;
    }
  }
  if (args.type) where.type = args.type;
  if (args.account) {
    const accs = await db.account.findMany({ where: { userId, name: { contains: args.account as string } } });
    where.OR = [{ fromAccountId: { in: accs.map((a) => a.id) } }, { toAccountId: { in: accs.map((a) => a.id) } }];
  }
  if (args.contact) {
    const cts = await db.contact.findMany({ where: { userId, name: { contains: args.contact as string } } });
    where.contactId = { in: cts.map((c) => c.id) };
  }
  if (args.category) {
    const cats = await db.category.findMany({ where: { userId, name: { contains: args.category as string } } });
    where.categoryId = { in: cats.map((c) => c.id) };
  }
  const limit = Number(args.limit ?? 100);

  const txns = await db.transaction.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: limit,
    include: { fromAccount: true, toAccount: true, contact: true, category: true },
  });

  return JSON.stringify(
    txns.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      category: t.category?.name,
      from_account: t.fromAccount?.name,
      to_account: t.toAccount?.name,
      contact: t.contact?.name,
      timestamp: t.timestamp.toISOString(),
      notes: t.notes,
    }))
  );
}

export async function aggregate(userId: string, args: Args): Promise<string> {
  const where: any = { userId };
  if (args.from_date || args.to_date) {
    where.timestamp = {};
    if (args.from_date) where.timestamp.gte = new Date(args.from_date as string);
    if (args.to_date) {
      const t = new Date(args.to_date as string);
      t.setHours(23, 59, 59, 999);
      where.timestamp.lte = t;
    }
  }
  if (args.type) where.type = args.type;

  const txns = await db.transaction.findMany({
    where,
    include: { fromAccount: true, toAccount: true, contact: true, category: true },
  });

  const groupBy = args.group_by as string;
  const buckets: Record<string, { total: number; count: number }> = {};
  for (const t of txns) {
    let key = "";
    if (groupBy === "category") key = t.category?.name ?? "Uncategorized";
    else if (groupBy === "account") key = t.fromAccount?.name ?? t.toAccount?.name ?? "Unknown";
    else if (groupBy === "contact") key = t.contact?.name ?? "None";
    else if (groupBy === "type") key = t.type;
    else if (groupBy === "day") key = t.timestamp.toISOString().slice(0, 10);
    else if (groupBy === "week") {
      const d = t.timestamp;
      const onejan = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
      key = `${d.getFullYear()}-W${week}`;
    } else if (groupBy === "month") key = t.timestamp.toISOString().slice(0, 7);
    else key = "Unknown";

    if (!buckets[key]) buckets[key] = { total: 0, count: 0 };
    buckets[key].total += t.amount;
    buckets[key].count += 1;
  }

  return JSON.stringify(
    Object.entries(buckets).map(([k, v]) => ({
      dimension_value: k,
      total_amount: v.total,
      count: v.count,
      avg_amount: v.count ? v.total / v.count : 0,
    }))
  );
}

export async function getAccountSummary(userId: string, _args: Args): Promise<string> {
  const accounts = await db.account.findMany({
    where: { userId, isActive: true },
    orderBy: { type: "asc" },
  });
  return JSON.stringify(
    accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      institution: a.institution,
      balance: a.balance,
      currency: a.currency,
    }))
  );
}

export async function createScheduledNotification(userId: string, args: Args): Promise<string> {
  const schedule = String(args.schedule);
  const message = String(args.message);
  const notif = await db.scheduledNotification.create({
    data: { userId, schedule, message, isActive: true },
  });
  return `Scheduled notification created (ID: ${notif.id}). Schedule: ${schedule}. Message: ${message}. NOTE: Actual push delivery requires Web Push subscription + QStash integration (Phase 3).`;
}

export async function exportData(userId: string, args: Args): Promise<string> {
  const format = (args.format as string) ?? "csv";
  const params = new URLSearchParams();
  params.set("format", format);
  if (args.from_date) params.set("from", String(args.from_date));
  if (args.to_date) params.set("to", String(args.to_date));
  return `Export ready. Download URL: /api/dashboard/export?${params.toString()} (user can click this link to download the ${format.toUpperCase()} file).`;
}

// ============================================================
//  MINDMAP TOOLS (Phase 3) — agent can read + propose edits to mindmaps
// ============================================================

export async function listMindmaps(userId: string, _args: Args): Promise<string> {
  const maps = await db.mindmap.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, updatedAt: true },
  });
  if (maps.length === 0) return "User has no mindmaps yet.";
  return "Mindmaps:\n" + maps.map((m) => `- ${m.id} | ${m.name} | updated ${m.updatedAt.toISOString()}`).join("\n");
}

export async function getMindmap(userId: string, args: Args): Promise<string> {
  const id = args.id as string | undefined;
  const name = args.name as string | undefined;
  if (!id && !name) return "Error: need id or name";
  const map = id
    ? await db.mindmap.findFirst({ where: { id, userId } })
    : await db.mindmap.findFirst({ where: { userId, name: { contains: name! } } });
  if (!map) return "Error: mindmap not found";
  return JSON.stringify({
    id: map.id,
    name: map.name,
    nodes: JSON.parse(map.nodes || "[]"),
    edges: JSON.parse(map.edges || "[]"),
    updatedAt: map.updatedAt.toISOString(),
  });
}

/**
 * Agentic mindmap edit: agent proposes new nodes + edges (full replacement or patch).
 * We do NOT auto-save — the user must click "Save" in the UI to commit.
 * Returns the proposed graph as JSON so the agent can describe what it changed.
 *
 * Accepts BOTH shapes of nodes/edges:
 *   - SIMPLE:  {id, label}                  (preferred — smaller JSON, fits LLM token budget)
 *   - FULL:    {id, type, position, data:{label}}  (React Flow native shape)
 *
 * The server normalizes SIMPLE → FULL by auto-assigning type="default" and a
 * grid-layout position based on the node's index in the array. The user can
 * then drag nodes around in the mindmap editor to fine-tune the layout.
 *
 * Similarly for edges:
 *   - SIMPLE:  {source, target}             (server auto-generates id)
 *   - FULL:    {id, source, target, label?}  (passed through)
 */
export async function proposeMindmapEdit(userId: string, args: Args): Promise<string> {
  const id = args.id as string | undefined;
  const name = args.name as string | undefined;
  if (!id && !name) return "Error: need id or name to identify mindmap";

  const map = id
    ? await db.mindmap.findFirst({ where: { id, userId } })
    : await db.mindmap.findFirst({ where: { userId, name: { contains: name! } } });
  if (!map) return "Error: mindmap not found";

  const newNodesRaw = Array.isArray(args.nodes) ? args.nodes : null;
  const newEdgesRaw = Array.isArray(args.edges) ? args.edges : null;
  const summary = (args.summary as string) ?? "Agent edited the mindmap.";

  if (!newNodesRaw && !newEdgesRaw) {
    return "Error: must provide at least one of nodes or edges as a JSON array";
  }

  // Normalize nodes: accept both {id, label} (simple) and {id, type, position, data:{label}} (full)
  const normalizedNodes = (newNodesRaw ?? []).map((node: any, i: number) => {
    if (node?.data?.label !== undefined) {
      // Already full React Flow shape — pass through
      return {
        id: String(node.id ?? `n${i}`),
        type: node.type ?? "default",
        position: node.position ?? { x: (i % 5) * 200, y: Math.floor(i / 5) * 120 },
        data: { label: String(node.data.label ?? node.id ?? `Node ${i + 1}`) },
      };
    }
    // Simple shape: {id, label}
    return {
      id: String(node?.id ?? `n${i}`),
      type: "default",
      position: { x: (i % 5) * 200, y: Math.floor(i / 5) * 120 },
      data: { label: String(node?.label ?? node?.id ?? `Node ${i + 1}`) },
    };
  });

  // Normalize edges: accept both {source, target} (simple) and {id, source, target, label?} (full)
  const normalizedEdges = (newEdgesRaw ?? []).map((edge: any, i: number) => ({
    id: String(edge?.id ?? `e${i}_${edge?.source ?? "s"}_${edge?.target ?? "t"}`),
    source: String(edge?.source ?? ""),
    target: String(edge?.target ?? ""),
    label: edge?.label,
  }));

  return JSON.stringify({
    mindmapId: map.id,
    mindmapName: map.name,
    proposed: {
      nodes: normalizedNodes,
      edges: normalizedEdges,
    },
    summary,
    actionRequired: "REVIEW_AND_SAVE",
    note: "I've prepared a proposed edit. The user must review and click 'Save' in the mindmap editor to commit it. Do NOT claim the mindmap is saved until they confirm.",
  });
}

// ============================================================
//  MULTI-LEG GROUP TOOLS
// ============================================================

export async function linkTransactions(userId: string, args: Args): Promise<string> {
  const txnIds = (args.txn_ids as string[]) ?? [];
  if (txnIds.length < 2) return "Error: need at least 2 txn_ids to link";
  const groupLabel = String(args.group_label);
  const description = (args.description as string) ?? null;

  // Verify all txns belong to this user
  const txns = await db.transaction.findMany({
    where: { id: { in: txnIds }, userId },
  });
  if (txns.length !== txnIds.length) {
    return `Error: only found ${txns.length} of ${txnIds.length} txns (some may not exist or belong to another user)`;
  }

  // Create or find the group
  let group = await db.transactionGroup.findFirst({
    where: { userId, label: { contains: groupLabel } },
  });
  if (!group) {
    group = await db.transactionGroup.create({
      data: { userId, label: groupLabel, description },
    });
  }

  // Link all txns to this group
  await db.transaction.updateMany({
    where: { id: { in: txnIds }, userId },
    data: { groupId: group.id },
  });

  return `Linked ${txns.length} transactions to group "${groupLabel}" (group ID: ${group.id}).`;
}

export async function markEvent(userId: string, args: Args): Promise<string> {
  const eventType = String(args.event_type);
  const account = await findAccount(userId, args.related_account as string | undefined);
  const contact = await findContact(userId, args.related_contact as string | undefined);
  const groupId = await findOrCreateGroup(userId, args.group_label as string | undefined);
  const timestamp = args.timestamp ? new Date(args.timestamp as string) : new Date();

  const txn = await db.transaction.create({
    data: {
      userId,
      type: "transfer", // neutral type for events (no income/expense impact)
      amount: 0,
      fromAccountId: account?.id,
      contactId: contact?.id,
      groupId,
      timestamp,
      notes: (args.notes as string) ?? `Event: ${eventType}`,
      source: "chat",
      status: "confirmed",
      metadata: JSON.stringify({ eventType, isEvent: true }),
    },
  });
  const groupNote = groupId ? ` [group: ${args.group_label}]` : "";
  return `Marked event "${eventType}"${account ? ` (account: ${account.name})` : ""}${contact ? ` (contact: ${contact.name})` : ""}.${groupNote} Txn ID: ${txn.id}`;
}

export async function listGroups(userId: string, args: Args): Promise<string> {
  const where: any = { userId };
  if (args.label_contains) {
    where.label = { contains: args.label_contains as string };
  }
  const groups = await db.transactionGroup.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { _count: { select: { transactions: true } } },
  });
  if (groups.length === 0) return "No transaction groups found.";
  return JSON.stringify(
    groups.map((g) => ({
      id: g.id,
      label: g.label,
      description: g.description,
      legs: g._count.transactions,
      created_at: g.createdAt.toISOString(),
    }))
  );
}

export async function getGroupSummary(userId: string, args: Args): Promise<string> {
  let group;
  if (args.group_id) {
    group = await db.transactionGroup.findFirst({
      where: { id: args.group_id as string, userId },
    });
  } else if (args.label) {
    group = await db.transactionGroup.findFirst({
      where: { userId, label: { contains: args.label as string } },
    });
  }
  if (!group) return "Error: group not found";

  const txns = await db.transaction.findMany({
    where: { groupId: group.id, userId },
    orderBy: { timestamp: "asc" },
    include: { fromAccount: true, toAccount: true, contact: true, category: true },
  });

  const summary = {
    group_id: group.id,
    label: group.label,
    description: group.description,
    created_at: group.createdAt.toISOString(),
    leg_count: txns.length,
    net_amount: txns.reduce((sum, t) => {
      if (t.type === "income" || t.type === "profit" || t.type === "loan_in") return sum + t.amount;
      if (t.type === "expense" || t.type === "loss" || t.type === "fee" || t.type === "loan_out") return sum - t.amount;
      return sum; // transfer or event
    }, 0),
    legs: txns.map((t) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      category: t.category?.name,
      from_account: t.fromAccount?.name,
      to_account: t.toAccount?.name,
      contact: t.contact?.name,
      timestamp: t.timestamp.toISOString(),
      notes: t.notes,
    })),
  };
  return JSON.stringify(summary, null, 2);
}

// ============================================================
//  SEMANTIC RETRIEVAL (RAG mode)
// ============================================================

/**
 * Tokenize a free-form natural-language query into searchable keywords
 * and 2-grams. Returns both lists.
 *
 * Examples:
 *   "show me my recent rapido expenses"
 *     keywords: ["show","me","my","recent","rapido","expenses"]
 *     bigrams:  ["show me","me my","my recent","recent rapido","rapido expenses"]
 *
 * Stop-words are stripped so generic words don't dilute the signal.
 */
function tokenizeQuery(q: string): { keywords: string[]; bigrams: string[] } {
  const STOPWORDS = new Set([
    "a","an","the","is","are","was","were","be","been","being","of","in","on","at","to","for","with","by","from","up","down","as","and","or","but","not","no","yes","my","i","me","we","our","us","you","your","he","she","it","they","them","his","her","its","their","this","that","these","those","what","which","who","whom","how","why","when","where","do","does","did","done","have","has","had","can","could","should","would","may","might","will","shall","show","tell","about","all","any","some","more","most","less","than","then","so","such","very","just","also","too","here","there",
  ]);
  const lower = (q || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const tokens = lower.split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  const keywords = Array.from(new Set(tokens));
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return { keywords, bigrams: Array.from(new Set(bigrams)) };
}

/**
 * Semantic transaction retrieval — used by the RAG-mode agent to find
 * transactions matching a natural-language query without explicit filters.
 *
 * Strategy (no embeddings, no vector DB — works on SQLite or Postgres):
 *   1. Tokenize the query into keywords + bigrams.
 *   2. Pull a wide candidate set (default: last 90 days, max 1000 txns —
 *      narrowed by optional date range if the LLM provided one).
 *   3. Score each txn by counting keyword + bigram occurrences in its
 *      concatenated text fields (notes, category, account names, contact
 *      name, type). Bigrams count 3x, keywords 1x.
 *   4. Return top N (default 25) sorted by score desc, then timestamp desc.
 *
 * The LLM can then read these results to answer the user's question.
 */
export async function retrieveTransactions(userId: string, args: Args): Promise<string> {
  const query = String(args.query ?? "");
  if (!query.trim()) return "Error: query is required";
  const topN = Number(args.top_n ?? 25);
  const days = Number(args.days ?? 90);

  // Build candidate set with optional date range filter
  const where: any = { userId };
  if (args.from_date || args.to_date || days > 0) {
    where.timestamp = {};
    if (args.from_date) where.timestamp.gte = new Date(args.from_date as string);
    if (args.to_date) {
      const t = new Date(args.to_date as string);
      t.setHours(23, 59, 59, 999);
      where.timestamp.lte = t;
    }
    if (days > 0 && !args.from_date) {
      where.timestamp.gte = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }
  }

  const candidates = await db.transaction.findMany({
    where,
    orderBy: { timestamp: "desc" },
    take: 1000,
    include: { fromAccount: true, toAccount: true, contact: true, category: true },
  });

  if (candidates.length === 0) return JSON.stringify({ matches: [], total_scanned: 0, message: "No transactions found." });

  const { keywords, bigrams } = tokenizeQuery(query);

  // Score each candidate
  const scored = candidates.map((t) => {
    const textParts = [
      t.notes ?? "",
      t.category?.name ?? "",
      t.fromAccount?.name ?? "",
      t.toAccount?.name ?? "",
      t.contact?.name ?? "",
      t.type,
      // Also tokenize the metadata.rawText (from statement upload) for richer matching
      (() => {
        try {
          const m = JSON.parse(t.metadata ?? "{}");
          return m.rawText ?? "";
        } catch { return ""; }
      })(),
    ];
    const haystack = " " + textParts.join(" ").toLowerCase() + " ";
    let score = 0;
    for (const kw of keywords) {
      // count occurrences
      let idx = haystack.indexOf(kw);
      while (idx >= 0) { score += 1; idx = haystack.indexOf(kw, idx + kw.length); }
    }
    // Bigrams count 3x — they indicate stronger relevance
    for (const bg of bigrams) {
      if (haystack.includes(bg)) score += 3;
    }
    return { t, score };
  });

  // Sort: score desc, then timestamp desc
  scored.sort((a, b) => b.score - a.score || b.t.timestamp.getTime() - a.t.timestamp.getTime());

  // Take only positive-score matches; if none have score, fall back to top 10 by recency
  const positiveMatches = scored.filter((s) => s.score > 0).slice(0, topN);
  const finalMatches = positiveMatches.length > 0 ? positiveMatches : scored.slice(0, Math.min(10, topN));

  return JSON.stringify({
    query,
    keywords_used: keywords,
    bigrams_used: bigrams,
    total_scanned: candidates.length,
    matches_returned: finalMatches.length,
    fallback_to_recent: positiveMatches.length === 0,
    matches: finalMatches.map(({ t, score }) => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      category: t.category?.name,
      from_account: t.fromAccount?.name,
      to_account: t.toAccount?.name,
      contact: t.contact?.name,
      timestamp: t.timestamp.toISOString(),
      notes: t.notes,
      relevance_score: score,
      group_id: t.groupId,
    })),
  });
}

// ============================================================
//  Tool dispatcher
// ============================================================

export async function dispatchTool(
  toolName: string,
  userId: string,
  args: Args
): Promise<string> {
  switch (toolName) {
    case "log_expense": return logExpense(userId, args);
    case "log_income": return logIncome(userId, args);
    case "log_transfer": return logTransfer(userId, args);
    case "create_account": return createAccount(userId, args);
    case "create_contact": return createContact(userId, args);
    case "ask_clarification": return askClarification(userId, args);
    case "query_transactions": return queryTransactions(userId, args);
    case "aggregate": return aggregate(userId, args);
    case "get_account_summary": return getAccountSummary(userId, {});
    case "retrieve_transactions": return retrieveTransactions(userId, args);
    case "create_scheduled_notification": return createScheduledNotification(userId, args);
    case "export_data": return exportData(userId, args);
    case "link_transactions": return linkTransactions(userId, args);
    case "mark_event": return markEvent(userId, args);
    case "list_groups": return listGroups(userId, args);
    case "get_group_summary": return getGroupSummary(userId, args);
    case "list_mindmaps": return listMindmaps(userId, args);
    case "get_mindmap": return getMindmap(userId, args);
    case "propose_mindmap_edit": return proposeMindmapEdit(userId, args);
    default: return `Error: unknown tool ${toolName}`;
  }
}
