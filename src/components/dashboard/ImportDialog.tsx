"use client";

import { useState } from "react";
import { toast } from "sonner";
import { X, ClipboardPaste, Copy, FileCheck2, AlertTriangle, Check, Loader2, MessageCircle } from "lucide-react";

/**
 * Import dialog — paste the markdown/JSON block produced by ANY external AI
 * chatbot (via public/addingaccountsprompt.md) and bring your accounts,
 * contacts, and categories into Khata.
 *
 * Flow: paste → preview (new items + conflicts with choices) → apply.
 * Conflicts are resolved per item (keep existing vs use imported); anything
 * still unclear can be settled with the site agent afterwards.
 */

interface Conflict {
  kind: "account" | "contact";
  name: string;
  field: string;
  existingValue: string;
  importedValue: string;
}

interface PreviewData {
  summary: {
    accountsTotal: number;
    contactsTotal: number;
    categoriesTotal: number;
    newAccounts: number;
    newContacts: number;
    newCategories: number;
    conflicts: number;
  };
  newItems: {
    accounts: Array<{ name: string; type: string; institution?: string | null; balance: number }>;
    contacts: Array<{ name: string; type: string; relationship?: string | null; balance: number }>;
    categories: Array<{ name: string; type: string }>;
  };
  conflicts: Conflict[];
}

type ApplyResult = {
  createdAccounts: number;
  updatedAccounts: number;
  createdContacts: number;
  updatedContacts: number;
  createdCategories: number;
} | null;

export default function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [content, setContent] = useState("");
  const [phase, setPhase] = useState<"paste" | "review" | "done">("paste");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [result, setResult] = useState<ApplyResult>(null);
  const [decisions, setDecisions] = useState<Record<string, "update" | "skip">>({});
  const [busy, setBusy] = useState(false);
  const [copying, setCopying] = useState(false);

  const analyze = async () => {
    if (!content.trim()) {
      toast.error("Paste the markdown or JSON block from the other AI first");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/dashboard/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error ?? "Couldn't read that data");
        return;
      }
      setPreview(j);
      // Default decision: skip (keep existing) — user opts IN to overwrites
      const d: Record<string, "update" | "skip"> = {};
      for (const c of j.conflicts ?? []) d[`${c.kind}:${c.name}`] = "skip";
      setDecisions(d);
      setPhase("review");
    } catch (e: any) {
      toast.error(e?.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!content.trim()) return;
    setBusy(true);
    try {
      const resolutions = Object.entries(decisions)
        .filter(([, action]) => action === "update")
        .map(([key]) => {
          const [kind, ...rest] = key.split(":");
          return { kind, name: rest.join(":"), action: "update" };
        });
      const res = await fetch("/api/dashboard/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, confirmed: true, resolutions }),
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error ?? "Import failed");
        return;
      }
      setResult(j.result);
      setPhase("done");
      onDone();
    } catch (e: any) {
      toast.error(e?.message ?? "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async () => {
    setCopying(true);
    try {
      const res = await fetch("/addingaccountsprompt.md");
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      toast.success("Prompt copied — paste it into any AI chatbot");
    } catch {
      toast.error("Couldn't copy — open /addingaccountsprompt.md and copy manually");
    } finally {
      setCopying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-foreground/40 backdrop-blur-[2px] flex items-center justify-center p-4 anim-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto anim-pop-in shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-card px-5 py-4 flex items-center justify-between border-b border-border">
          <p className="font-semibold text-sm text-foreground">Import your financial data</p>
          <button
            onClick={onClose}
            className="press h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Step 1 hint + copy prompt */}
          <div className="rounded-xl border border-border bg-muted/40 p-3.5 text-xs text-muted-foreground space-y-2">
            <p>
              <span className="font-medium text-foreground">Step 1:</span> Copy the setup prompt below and paste it into
              any AI chatbot (ChatGPT, Claude, Gemini…). It interviews you about your accounts, balances, contacts —
              and can also read CSV data you give it — then outputs a formatted block.
            </p>
            <button
              onClick={copyPrompt}
              disabled={copying}
              className="press h-8 px-3 rounded-lg border border-input text-xs font-medium text-foreground flex items-center gap-1.5 hover:bg-accent/50 transition-colors disabled:opacity-60"
            >
              {copying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Copy className="w-3 h-3" />}
              Copy addingaccountsprompt.md
            </button>
          </div>

          {phase === "paste" && (
            <>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Step 2:</span> Paste the markdown or JSON block the other
                AI produced. Nothing is saved until you review it.
              </p>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={"# Khata Import\n\n## Accounts\n| name | type | institution | balance | notes |…"}
                className="w-full h-48 rounded-xl border border-input bg-background px-3.5 py-3 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/40 resize-none"
              />
              <div className="flex justify-end">
                <button
                  onClick={analyze}
                  disabled={busy || !content.trim()}
                  className="press h-10 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 disabled:opacity-60"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardPaste className="w-4 h-4" />}
                  Review import
                </button>
              </div>
            </>
          )}

          {phase === "review" && preview && (
            <>
              {/* Summary */}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl border border-border p-3">
                  <p className="text-lg font-semibold text-foreground tnum">{preview.summary.newAccounts}</p>
                  <p className="text-[11px] text-muted-foreground">new accounts{preview.summary.accountsTotal > preview.summary.newAccounts ? ` (${preview.summary.accountsTotal - preview.summary.newAccounts} exist)` : ""}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-lg font-semibold text-foreground tnum">{preview.summary.newContacts}</p>
                  <p className="text-[11px] text-muted-foreground">new contacts</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-lg font-semibold text-foreground tnum">{preview.summary.newCategories}</p>
                  <p className="text-[11px] text-muted-foreground">new categories</p>
                </div>
              </div>

              {/* New items */}
              <div className="rounded-xl border border-border divide-y divide-border max-h-44 overflow-y-auto">
                {preview.newItems.accounts.map((a) => (
                  <div key={`a-${a.name}`} className="flex items-center justify-between px-3.5 py-2 text-xs">
                    <span className="text-foreground font-medium">{a.name} <span className="text-muted-foreground font-normal">· {a.type}{a.institution ? ` · ${a.institution}` : ""}</span></span>
                    <span className="font-mono text-foreground tnum">₹{a.balance.toLocaleString("en-IN")}</span>
                  </div>
                ))}
                {preview.newItems.contacts.map((c) => (
                  <div key={`c-${c.name}`} className="flex items-center justify-between px-3.5 py-2 text-xs">
                    <span className="text-foreground font-medium">{c.name} <span className="text-muted-foreground font-normal">· {c.type}</span></span>
                    <span className={`font-mono tnum ${c.balance >= 0 ? "text-success" : "text-destructive"}`}>
                      {c.balance >= 0 ? "+" : "−"}₹{Math.abs(c.balance).toLocaleString("en-IN")}
                    </span>
                  </div>
                ))}
                {preview.newItems.categories.length > 0 && (
                  <div className="px-3.5 py-2 text-xs text-muted-foreground">
                    + categories: {preview.newItems.categories.map((c) => c.name).join(", ")}
                  </div>
                )}
              </div>

              {/* Conflicts */}
              {preview.conflicts.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                    {preview.conflicts.length} conflict{preview.conflicts.length > 1 ? "s" : ""} with your existing data
                  </p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {preview.conflicts.map((c) => (
                      <div key={`${c.kind}-${c.name}`} className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
                        <div className="flex items-center justify-between">
                          <p className="font-medium text-foreground">{c.name} <span className="text-muted-foreground font-normal">({c.kind}, {c.field})</span></p>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => setDecisions((d) => ({ ...d, [`${c.kind}:${c.name}`]: "skip" }))}
                              className={`press h-7 px-2.5 rounded-lg border text-[11px] font-medium transition-colors ${
                                decisions[`${c.kind}:${c.name}`] === "skip"
                                  ? "border-primary bg-accent text-accent-foreground"
                                  : "border-input text-muted-foreground hover:border-ring/50"
                              }`}
                            >
                              Keep mine
                            </button>
                            <button
                              onClick={() => setDecisions((d) => ({ ...d, [`${c.kind}:${c.name}`]: "update" }))}
                              className={`press h-7 px-2.5 rounded-lg border text-[11px] font-medium transition-colors ${
                                decisions[`${c.kind}:${c.name}`] === "update"
                                  ? "border-primary bg-accent text-accent-foreground"
                                  : "border-input text-muted-foreground hover:border-ring/50"
                              }`}
                            >
                              Use imported
                            </button>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mt-2">
                          <p className="text-muted-foreground">existing: <span className="text-foreground">{c.existingValue}</span></p>
                          <p className="text-muted-foreground">imported: <span className="text-foreground">{c.importedValue}</span></p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <MessageCircle className="w-3 h-3" />
                    Unsure? Skip for now and ask the chat assistant — it can update any account for you.
                  </p>
                </div>
              )}

              <div className="flex justify-between items-center pt-1">
                <button onClick={() => setPhase("paste")} className="press text-xs text-muted-foreground hover:text-foreground">
                  ← back
                </button>
                <button
                  onClick={apply}
                  disabled={busy}
                  className="press h-10 px-4 rounded-xl bg-primary text-primary-foreground text-sm font-medium flex items-center gap-2 disabled:opacity-60"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCheck2 className="w-4 h-4" />}
                  Import {preview.summary.newAccounts + preview.summary.newContacts > 0
                    ? `(${preview.summary.newAccounts + preview.summary.newContacts + preview.summary.newCategories} new)`
                    : ""}
                </button>
              </div>
            </>
          )}

          {phase === "done" && result && (
            <div className="text-center py-6 space-y-3">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-success/15 text-success">
                <Check className="w-6 h-6" />
              </div>
              <div className="text-sm text-foreground space-y-1">
                <p>
                  Added <b>{result.createdAccounts}</b> account{result.createdAccounts !== 1 ? "s" : ""}
                  {result.updatedAccounts > 0 ? `, updated ${result.updatedAccounts}` : ""}
                  {result.createdContacts > 0 ? <> · <b>{result.createdContacts}</b> contact{result.createdContacts !== 1 ? "s" : ""}</> : null}
                  {result.updatedContacts > 0 ? ` (updated ${result.updatedContacts})` : ""}
                  {result.createdCategories > 0 ? <> · <b>{result.createdCategories}</b> categor{result.createdCategories !== 1 ? "ies" : "y"}</> : null}
                </p>
                <p className="text-muted-foreground text-xs">
                  You can fine-tune anything by chatting with the assistant — try &quot;update my SBI balance to 5000&quot;.
                </p>
              </div>
              <button onClick={onClose} className="press h-10 px-5 rounded-xl bg-primary text-primary-foreground text-sm font-medium">
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
