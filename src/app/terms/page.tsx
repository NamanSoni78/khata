import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms that govern your use of Khata — a free, as-is personal money diary. Read what you agree to before creating an account.",
  alternates: { canonical: "/terms" },
};

const SECTIONS: { h: string; body: string[] }[] = [
  {
    h: "1. What Khata is",
    body: [
      "Khata is a free, personal finance diary offered as a Progressive Web App. You record transactions by typing or speaking, ask questions about your own data, and set reminders. It is a convenience tool, not a banking product, accounting service, or financial advisory service of any kind.",
      "Khata is operated by an independent developer (\"we\", \"us\"). By creating an account you accept these terms in full. If you do not agree with any part of them, do not create an account.",
    ],
  },
  {
    h: "2. Your account",
    body: [
      "Accounts are created with a Gmail address, a password, and verified with a one-time code sent to that address. You are responsible for keeping your password, 4-digit app MPIN, and 6-digit dashboard MPIN secret. Anyone who obtains them can read and modify your data — treat them like cash.",
      "You must be at least 18 years old (or have a guardian's consent) to use Khata. You are responsible for all activity that happens under your account.",
    ],
  },
  {
    h: "3. No professional advice",
    body: [
      "Nothing in Khata — replies from its assistant, summaries, charts, categories, or reminders — is financial, tax, legal, or investment advice. Numbers are parsed from what you tell us and may be incomplete, misheard, mis-categorized, or wrong. Always verify against your actual bank and brokerage records before making any decision.",
      "Do not use Khata as your only record of anything important. It is a diary, not a ledger of record.",
    ],
  },
  {
    h: "4. Your data — and who is responsible for it",
    body: [
      "You enter your own financial information into Khata. You decide what to share with it. We do not independently verify, audit, or back up the accuracy of what you enter.",
      "While we take reasonable technical measures for isolation between accounts, Khata is a free, hobby-grade service: we do not guarantee the security, integrity, availability, or confidentiality of your data. You use it at your own risk. Keep your own backups — export your data regularly from the dashboard.",
      "Do not store information you cannot afford to lose. Do not rely on Khata being available at any given moment.",
    ],
  },
  {
    h: "5. No uptime or continuity guarantee",
    body: [
      "The service may be slow, degraded, or unavailable at any time. It may lose data. It may be modified, suspended, or discontinued entirely — tomorrow or any day after — with or without notice, and with no obligation to export or return your data. There is no promise that Khata will exist next week, next month, or next year.",
      "Features may be added, changed, or removed at any time, including ones you rely on.",
    ],
  },
  {
    h: "6. AI features and third-party models",
    body: [
      "Khata's assistant is powered by large language models — either keys configured by the operator or, if you choose, your own API keys. Model output can be inaccurate, hallucinated, or unsuitable. Never act on assistant output without checking it yourself.",
      "When you configure your own API keys or custom endpoints, you are solely responsible for those keys, the endpoints they point to, any costs they incur on your provider account, and compliance with those providers' own terms.",
    ],
  },
  {
    h: "7. Acceptable use",
    body: [
      "You agree not to misuse Khata: no attempts to access other users' data, no scraping or resale of the service, no automated abuse of the APIs, no use of the service for unlawful purposes, and no uploading of content you have no right to upload.",
      "We may suspend or delete accounts that abuse the service, at our discretion, without notice.",
    ],
  },
  {
    h: "8. Emails",
    body: [
      "Khata sends transactional email (verification codes and password resets) through a third-party email provider to your Gmail address. Delivery is best-effort; codes may land in spam or not arrive. We cannot control Gmail's or the provider's filtering.",
    ],
  },
  {
    h: "9. Liability",
    body: [
      "To the maximum extent permitted by law, Khata and its operator accept no liability for anything arising from your use of the service: no liability for lost data, lost profits, missed reminders, wrong numbers, mis-parsed transactions, deleted accounts, or any direct or indirect damage.",
      "The service is provided \"as is\" and \"as available\", with no warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.",
    ],
  },
  {
    h: "10. Changes to these terms",
    body: [
      "These terms may be updated at any time. The current version always lives at this page. Continued use of Khata after an update means you accept the updated terms.",
    ],
  },
  {
    h: "11. Contact",
    body: [
      "Questions about these terms can be raised via the GitHub account listed on the landing page. There is no dedicated support channel and no guaranteed response time.",
    ],
  },
];

export default function TermsPage() {
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
          <h1 className="display-2 mt-1.5">Terms of Service</h1>
          <p className="text-[14px] text-muted-foreground leading-[1.7] mt-3 max-w-[52ch]">
            The plain-English deal: Khata is a free tool, provided as-is, with no guarantees.
            You are responsible for your data, your secrets, and your decisions.
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
              <Link href="/privacy" className="text-[var(--primary)] font-medium underline underline-offset-2">
                Privacy Policy
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
