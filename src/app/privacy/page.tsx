import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What Khata does (and does not do) with the data you enter. Read this before creating an account.",
  alternates: { canonical: "/privacy" },
};

const SECTIONS: { h: string; body: string[] }[] = [
  {
    h: "1. The short version",
    body: [
      "Khata stores what you type or speak into it — transactions, notes, account names — so it can answer your questions later. Data is tied to your account and is not shown to other users.",
      "But this is a free, hobby-run service. There is no security team, no audit, no guarantee of confidentiality or availability, and no promise the service exists tomorrow. If you would be upset to lose it or leak it, do not put it in Khata.",
    ],
  },
  {
    h: "2. What we collect",
    body: [
      "Account data: your Gmail address, a bcrypt-hashed password, hashed MPINs, your display name, and your UI preferences (wallpaper, voice language).",
      "Content data: every transaction, note, account, contact, and chat message you (or the assistant, on your behalf) create; uploaded statements and receipts; reminders you schedule.",
      "Technical data: session records, web-push subscription tokens for devices you enable notifications on, and standard server logs (IP addresses, timestamps, error logs) kept for troubleshooting.",
    ],
  },
  {
    h: "3. Where the data goes",
    body: [
      "Primary storage: a hosted SQLite-compatible database (Turso) chosen by the operator. Email delivery: a third-party email provider (Resend) is used to send verification and password-reset codes — the code and your address are shared with that provider, nothing more.",
      "AI processing: when you chat, your recent conversation context and a compact summary of your accounts are sent to whichever large-language-model provider is configured (by the operator, or by YOU with your own API key and endpoint from the dashboard settings). Those providers process your prompts under their own privacy terms — read them if you care.",
      "Push notifications: reminder content you create is delivered through browser push infrastructure and Upstash QStash schedules.",
    ],
  },
  {
    h: "4. Data security — honestly",
    body: [
      "We do not promise data security. Passwords and MPINs are hashed, and accounts are isolated from each other in the database, but the service has not been security-audited, and free infrastructure can fail, leak, or disappear.",
      "YOU are responsible for the secrecy of your credentials and for keeping your own backups. Export your data regularly. Assume that anything you store here could be lost or exposed at any time.",
    ],
  },
  {
    h: "5. Your own AI keys",
    body: [
      "If you set your own API keys or custom endpoints in the dashboard, they are stored on the server and used to call YOUR chosen providers on your behalf. Protect them; treat them like passwords. You accept full responsibility for their use and any resulting costs.",
    ],
  },
  {
    h: "6. No selling, but no guarantees either",
    body: [
      "We do not sell your data and there are no third-party analytics or ad trackers in Khata. The operator has no commercial interest in your data.",
      "However, because the service may be discontinued or handed over at any time, you should treat long-term confidentiality as YOUR responsibility, not ours.",
    ],
  },
  {
    h: "7. Deleting your data",
    body: [
      "You can request deletion of your account and data by contacting the operator via the GitHub account listed on the landing page. Deletion removes your account, transactions, chats, and reminders from the primary database. We cannot claw back messages already sent to AI providers, email providers, or your own devices.",
    ],
  },
  {
    h: "8. Children",
    body: [
      "Khata is not directed at children under 13, and financial data of children should not be entered.",
    ],
  },
  {
    h: "9. Changes",
    body: [
      "This policy may change at any time; the current version always lives at this page. Using Khata after a change means you accept it.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <div className="min-h-dvh flex flex-col auth-canvas">
      <header className="safe-top shrink-0">
        <div className="max-w-2xl mx-auto px-4 pt-4 flex items-center gap-2">
          <Link href="/" className="press h-10 w-10 flex items-center justify-center rounded-full text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 transition-colors" aria-label="Back to Khata">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="brand-chip w-8 h-8 flex items-center justify-center" style={{ borderRadius: 10 }} aria-hidden>
            <span className="font-display font-extrabold text-white leading-none" style={{ fontSize: 15, marginBottom: 1 }}>₹</span>
          </div>
          <p className="font-display font-bold text-[15px]">Khata</p>
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 py-6">
        <div className="card-v4 p-7 sm:p-9 anim-fade-up">
          <p className="eyebrow">Last updated · October 2026</p>
          <h1 className="display-2 mt-1.5">Privacy Policy</h1>
          <p className="text-[14px] text-muted-foreground leading-[1.7] mt-3 max-w-[52ch]">
            The short version: what you type or speak stays in your account. We sell nothing,
            share nothing, and promise nothing beyond that.
          </p>

          <div className="mt-8 space-y-8">
            {SECTIONS.map((s) => {
              const num = s.h.split(".")[0];
              return (
                <section key={s.h} className="grid sm:grid-cols-[34px_1fr] gap-x-3 gap-y-1.5">
                  <span className="font-display font-extrabold text-[15px] text-[var(--primary)] tnum pt-0.5">{num}</span>
                  <div>
                    <h2 className="font-display font-bold text-[15.5px] mb-2.5">{s.h.replace(/^\d+\.\s*/, "")}</h2>
                    {s.body.map((p, i) => (
                      <p key={i} className="text-[13.5px] text-foreground/75 leading-[1.75] mb-3 last:mb-0 max-w-[58ch]">
                        {p}
                      </p>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>

          <div className="mt-10 pt-6 border-t border-border text-[12.5px] text-muted-foreground">
            <p>
              See also the{" "}
              <Link href="/terms" className="text-[var(--primary)] font-medium underline underline-offset-2">
                Terms of Service
              </Link>
              .
            </p>
          </div>
        </div>
      </main>

      <footer className="pb-6 pt-2 text-center text-[12px] text-muted-foreground/70">
        <Link href="/" className="hover:underline">Khata</Link>
        <span className="mx-1.5">·</span>
        <Link href="/terms" className="hover:underline">Terms of Service</Link>
        <span className="mx-1.5">·</span>
        <Link href="/privacy" className="hover:underline">Privacy Policy</Link>
      </footer>
    </div>
  );
}
