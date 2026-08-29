# Khatabook Ledger — Deploy Guide

A production-grade multi-tenant personal-ledger PWA built on Next.js 16 App Router.

## Routes
- `/`         daily PWA chat + voice input
- `/dashboard` weekly deep-dive + AI insights agent
- `/admin`    developer / multi-tenant control panel

## Stack
- Next.js 16 (App Router, RSC, Server Actions)
- Tailwind 4 + shadcn/ui
- Prisma ORM + Neon serverless Postgres
- Auth.js v5 (credentials + WebAuthn + bcrypt MPIN)
- Recharts, React Flow, jsPDF, papaparse
- z-ai-web-dev-sdk (LLM) — OpenAI-compatible + Anthropic dual protocol

## 1. Install
\`\`\`bash
bun install        # or: pnpm i / npm i
\`\`\`

## 2. Configure env
\`\`\`bash
cp .env.example .env.local
# fill in DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD (LLM keys go in the /admin panel, not env)
\`\`\`

## 3. Database
\`\`\`bash
bunx prisma generate
bunx prisma migrate deploy    # or: bunx prisma db push for prototyping
\`\`\`

## 4. Run
\`\`\`bash
bun dev              # local
bun run build && bun start   # production
\`\`\`

## 5. Deploy to Vercel
1. Push this folder to a Git repo.
2. Import the repo into Vercel.
3. Set the same env vars in Project Settings.
4. Use build command `prisma generate && next build`.
5. (Optional) Add the Neon integration so DATABASE_URL is wired automatically.

## Phase 4 features included
- Mind-map editor (React Flow): view + form edit + agentic edit, undo/redo, explicit save
- PDF / CSV export from the dashboard
- Dashboard deep-dive agent (50+ financial terms: IPO, SIP, FD, demat, ...)
- 15-minute idle timeout, activity-extended
- Text-first AI replies with "Show chart" follow-up button
