import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getSessionToken } from "@/lib/auth/cookies";
import { db } from "@/lib/db";
import { parseImportContent, detectConflicts } from "@/lib/agent/import-parser";

/**
 * POST /api/dashboard/import
 *
 * Two-phase import (the markdown/JSON comes from ANY other AI chatbot that the
 * user gave public/addingaccountsprompt.md to):
 *
 * Phase 1 — PREVIEW (body: { content })
 *   Parses + validates the payload, compares with existing entities, returns
 *   { summary, newItems, conflicts } — nothing is written.
 *
 * Phase 2 — APPLY (body: { content, confirmed: true, resolutions? })
 *   resolutions: [{ kind: 'account'|'contact', name, action: 'update'|'skip' }]
 *   - new entities → created
 *   - conflicts   → 'update' overwrites balance/type, 'skip' (default) keeps existing
 *   - matching categories → merged silently (existing kept, new ones created)
 *
 * After applying, any remaining doubts can be resolved conversationally with
 * the site agent (the daily chat can create/update accounts on request).
 */
export async function POST(req: NextRequest) {
  const token = await getSessionToken("dashboard");
  const user = await getSessionUser(token, "dashboard");
  if (!user || user.id === "admin") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const content = String(body.content ?? "");
  if (!content.trim()) {
    return NextResponse.json({ error: "Paste the markdown or JSON from the other AI first." }, { status: 400 });
  }

  // Parse (format-agnostic: JSON / markdown tables / CSV)
  const parsed = parseImportContent(content);
  if (parsed.accounts.length + parsed.contacts.length + parsed.categories.length === 0) {
    return NextResponse.json({
      error: "Couldn't find any accounts, contacts or categories in that text. Make sure the other AI followed the Khata import prompt.",
    }, { status: 400 });
  }

  // Load existing entities for conflict detection
  const [accounts, contacts, categories] = await Promise.all([
    db.account.findMany({ where: { userId: user.id }, select: { id: true, name: true, balance: true, type: true, institution: true } }),
    db.contact.findMany({ where: { userId: user.id }, select: { id: true, name: true, balance: true, type: true } }),
    db.category.findMany({ where: { userId: user.id }, select: { id: true, name: true, type: true } }),
  ]);

  const conflicts = await detectConflicts(user.id, parsed, { accounts, contacts });

  // ---- PHASE 1: preview only ----
  if (!body.confirmed) {
    const newAccounts = parsed.accounts.filter((a) => !accounts.some((e) => e.name.toLowerCase() === a.name.toLowerCase()));
    const newContacts = parsed.contacts.filter((c) => !contacts.some((e) => e.name.toLowerCase() === c.name.toLowerCase()));
    const newCategories = parsed.categories.filter((c) => !categories.some((e) => e.name.toLowerCase() === c.name.toLowerCase()));

    return NextResponse.json({
      preview: true,
      summary: {
        accountsTotal: parsed.accounts.length,
        contactsTotal: parsed.contacts.length,
        categoriesTotal: parsed.categories.length,
        newAccounts: newAccounts.length,
        newContacts: newContacts.length,
        newCategories: newCategories.length,
        conflicts: conflicts.length,
      },
      newItems: {
        accounts: newAccounts,
        contacts: newContacts,
        categories: newCategories,
      },
      conflicts,
    });
  }

  // ---- PHASE 2: apply ----
  const resolutions: Array<{ kind: string; name: string; action: string }> = Array.isArray(body.resolutions)
    ? body.resolutions
    : [];
  const decision = (kind: string, name: string) =>
    resolutions.find((r) => r.kind === kind && r.name?.toLowerCase() === name.toLowerCase())?.action ?? "skip";

  let createdAccounts = 0, updatedAccounts = 0;
  let createdContacts = 0, updatedContacts = 0;
  let createdCategories = 0;

  // Accounts
  for (const a of parsed.accounts) {
    const existing = accounts.find((e) => e.name.toLowerCase() === a.name.toLowerCase());
    if (!existing) {
      await db.account.create({
        data: {
          userId: user.id,
          name: a.name,
          type: a.type,
          institution: a.institution ?? null,
          balance: a.balance,
          metadata: JSON.stringify({ imported: true, importedNotes: a.notes ?? null }),
        },
      });
      createdAccounts++;
    } else if (decision("account", a.name) === "update") {
      await db.account.update({
        where: { id: existing.id },
        data: {
          balance: a.balance,
          type: a.type,
          ...(a.institution ? { institution: a.institution } : {}),
        },
      });
      updatedAccounts++;
    }
  }

  // Contacts
  for (const c of parsed.contacts) {
    const existing = contacts.find((e) => e.name.toLowerCase() === c.name.toLowerCase());
    if (!existing) {
      await db.contact.create({
        data: {
          userId: user.id,
          name: c.name,
          type: c.type,
          relationship: c.relationship ?? null,
          balance: c.balance,
          metadata: JSON.stringify({ imported: true, importedNotes: c.notes ?? null }),
        },
      });
      createdContacts++;
    } else if (decision("contact", c.name) === "update") {
      await db.contact.update({
        where: { id: existing.id },
        data: { balance: c.balance, type: c.type },
      });
      updatedContacts++;
    }
  }

  // Categories (merge silently — never overwrite existing)
  for (const c of parsed.categories) {
    const existing = categories.find((e) => e.name.toLowerCase() === c.name.toLowerCase());
    if (!existing) {
      await db.category.create({
        data: { userId: user.id, name: c.name, type: c.type },
      });
      createdCategories++;
    }
  }

  return NextResponse.json({
    applied: true,
    result: {
      createdAccounts, updatedAccounts,
      createdContacts, updatedContacts,
      createdCategories,
    },
  });
}
