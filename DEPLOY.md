# Khata — Deploy Guide

A production-grade multi-tenant personal-finance PWA built on Next.js 16 App Router.
**Production URL: https://khata.namansoni.in**

## Routes
- `/`         daily PWA — chat + voice logging, balances, charts, reminders, markdown replies
- `/dashboard` weekly deep-dive + AI agent + imports + exports + reminders + mindmap editor
- `/admin`    developer / multi-tenant control panel (env-var auth)

## Stack
- Next.js 16 (App Router, RSC)
- Tailwind 4 + shadcn/ui
- Prisma ORM + Neon serverless Postgres
- Credentials auth + @simplewebauthn/server passkeys + bcrypt MPIN
- Recharts, React Flow, PDFKit
- LLM: OpenAI-compatible + Anthropic dual protocol (keys configured in /admin, not env)
- Web Push (VAPID) + Upstash QStash scheduling

## 1. Install
```bash
bun install        # or: pnpm i / npm i
```

## 2. Configure env
```bash
cp .env.example .env
# fill in DATABASE_URL (Neon pooled string), ADMIN_USERNAME, ADMIN_PASSWORD
# optional: NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_RP_ID, VAPID_*, QSTASH_*
```

## 3. Database
```bash
bunx prisma generate
bunx prisma db push
bun run db:seed     # default agent configs, flags, glossary, uxConfig
```

## 4. Run
```bash
bun run dev                 # local
bun run build && bun start  # production
```

## 5. Deploy to Vercel
1. Push this folder to a Git repo.
2. Import the repo into Vercel.
3. Set env vars in Project Settings (see README table: DATABASE_URL, ADMIN_*, VAPID_*, QSTASH_*, NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_RP_ID).
4. Deploy. Then run once against Neon: `DATABASE_URL=... bun run db:push && DATABASE_URL=... bun run db:seed`.
5. Set up QStash (exact-time schedules are automatic once QSTASH_TOKEN is set; add the `*/5 * * * *` catch-all cron → `https://khata.namansoni.in/api/notifications/cron`).
6. Log into `/admin`, configure the 4 agents (presets available), create user accounts.

## Post-deploy checklist
- [ ] Agents configured + "Test connection" green for each
- [ ] User account(s) created; MPIN + passkey set from a device
- [ ] Reminder test: ask the chat "remind me in 1 minute to test" (or set one in dashboard)
- [ ] Push enabled on a device; test notification received
- [ ] Import flow smoke-tested (Copy AI prompt → paste block → Import data)

## Included features
- Daily `/` chat with full analytical toolkit: live balances, date-range queries, charts, markdown
- No tool-call JSON leaks (hardened parser + sanitizer, native + fallback modes)
- Chat history pagination (100/page, scroll-up infinite retrieval from DB)
- Calendar reminders (daily/weekly/monthly/once — no cron syntax anywhere) via QStash
- Import from any AI chatbot via public/addingaccountsprompt.md (markdown/JSON/CSV)
- Mindmap editor (React Flow): view + form edit + agentic edit, undo/redo, explicit save
- PDF / CSV export from the dashboard
- Dashboard deep-dive agent (50+ financial terms: IPO, SIP, FD, demat, ...)
- 15-minute dashboard idle timeout, activity-extended
- Text-first AI replies with "Show chart" follow-up button
- Fingerprint auto-prompt on open, hold-to-talk mic (Hinglish-optimized STT)
- PWA install prompt (Chrome), offline message queue, chat wallpapers
- SEO: canonical, OG, robots.txt, sitemap.xml (no FAQ clutter)
