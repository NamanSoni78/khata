# Khata — Finance Tracker PWA

A production-grade multi-tenant personal finance tracker built as a PWA on Next.js 16 + Prisma + Neon serverless Postgres.
Lives at **khata.namansoni.in**.

Three routes, three threat models:

| Route | Auth | Idle timeout | Use case |
|---|---|---|---|
| `/` | Username + MPIN or WebAuthn passkey (fingerprint auto-prompts on open) | 30 days | Daily expense logging via chat / voice (Hinglish-aware) — **plus full analytical powers: charts, totals, date-range queries, reminders, exports** |
| `/dashboard` | Username + password (re-entry required) | **15 minutes idle** (active sessions auto-extend) | Weekly deep-dive: budgets, multi-period charts, AI agent, mindmap editor, imports, exports, reminders |
| `/admin` | `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars | 2 hours | Developer panel: per-agent LLM config, feature flags, system prompts, glossary, users, DB status |

## Highlights

- **Hinglish-aware transaction parsing** — understands natural multi-leg scenarios like
  *"Rahul ne 30 hazar diye IPO ke liye SBI mein, pichle baar ka 10k profit PNB mein aaya"* and
  logs all legs as one linked transaction group.
- **One chat does everything** — the daily `/` agent has the full analytical toolkit:
  live balances (always in context), date-range queries ("3 months ago how much did I send to Rahul?"),
  aggregations, and inline **charts** (text-first, then a "Show as chart" reveal).
- **Markdown in chat** — agent replies render `**bold**`, lists, tables, code.
- **No tool-call JSON leaks** — a hardened parser + final-reply sanitizer guarantee users never see
  raw `{"tool_call":...}` (works in both native and JSON-fallback tool-calling modes).
- **Effectively infinite context** — admin-sized recent-history window per call, plus a
  `search_chat_history` tool that searches EVERY past message, plus RAG transaction retrieval.
- **Chat history pagination** — UI loads the latest 100 messages; scrolling up fetches older
  pages from the DB on demand (everything is always saved).
- **Calendar-style reminders (no cron!)** — daily / weekly (weekday chips) / monthly / once,
  with date + time pickers. Delivered via **Upstash QStash**: per-reminder exact-time schedules
  (IST auto-converted to UTC cron) + a 5-min catch-all poll fallback + HMAC signature verification.
  Live placeholders: `{today_income} {today_expense} {month_income} {month_expense}`.
- **Import from any AI** — copy `public/addingaccountsprompt.md` (a strict interview-style system
  prompt) into ChatGPT/Claude/Gemini, answer its questions (it can also fold in your CSV data),
  then paste its markdown/JSON block into Dashboard → Accounts → **Import data**. Conflicts with
  existing accounts/contacts are surfaced with keep-mine / use-imported choices.
- **Per-agent model picker** — admin chooses provider + model per agent (daily chat / dashboard /
  STT / OCR). **OpenAI-compatible** (Groq, OpenAI, DeepSeek, OpenRouter, LM Studio) + **Anthropic-native**.
  Models without native tool-calling (e.g. Gemma) get the JSON fallback mode.
- **Liquid schema** — agent creates accounts / contacts / categories mid-conversation; admin can
  toggle LLM mode (full schema in prompt) vs RAG mode (on-demand retrieval).
- **Bank statement parsing** — PDFs / pasted text with duplicate detection (±5% amount + ±3 days);
  optional OCR/vision for images (admin-gated).
- **Instant unlock** — fingerprint prompt fires automatically on open (touch sensor → in);
  MPIN fallback; per-user auto-prompt toggle.
- **Voice input** — hold-to-talk mic with a Hinglish-optimized language picker
  (en-IN default: Hindi words come out in Latin script), hi-IN and en-US options.
- **PWA installable** — PNG icons + manifest + `beforeinstallprompt` handling (Chrome suggests
  install; in-app Install button too). Offline message queue flushes when back online.
- **Multi-period charts** — day (hourly), week/month (daily), 3m/6m (weekly), 1y/custom (monthly).
- **Mindmap editor** — React Flow canvas: view + form-edit + agentic edit + undo/redo + explicit Save.
- **PDF + CSV exports** — server-side PDFKit-generated, paginated, striped rows.
- **Web Push notifications** — VAPID + service worker + QStash scheduling.
- **Chat wallpaper** — subtle per-user tints (saved to the account, synced across devices).
- **SEO** — canonical URL, OpenGraph, robots.txt (API/admin/dashboard disallowed), sitemap.xml.
  No FAQ clutter — the app stays a clean daily-use tool.
- **Configurable reply pacing** — the ONLY delay in the pipeline is the admin-set
  `uxConfig.replyDelayMs` (default 0 = off). Everything else streams as fast as the model answers.

## Tech stack

- **Frontend**: Next.js 16 App Router, Tailwind CSS, shadcn/ui, Recharts, React Flow (`@xyflow/react`)
- **Backend**: Next.js API routes, Prisma ORM, Neon serverless Postgres
- **LLM clients**: OpenAI-compatible (Groq/OpenAI/DeepSeek/OpenRouter/LM Studio) + Anthropic-native,
  with a JSON fallback for models without tool-calling
- **Auth**: credentials + bcrypt + `@simplewebauthn/server` (passkeys) + bcrypt MPIN
- **PDF**: `pdf-parse` (input) + `pdfkit` (export)
- **Push**: `web-push` + VAPID + Upstash QStash (schedules + delayed publish)
- **Voice**: Web Speech API (native, language-selectable) or admin-configured OpenAI-compatible STT

---

## Local development

### Prerequisites

- **Node.js 18+** (or **Bun** — preferred)
- A Neon Postgres database (free tier is enough) — or a local Postgres

### First-time setup

```bash
# 1. Install deps
bun install   # or: npm install

# 2. Configure env
cp .env.example .env
# Edit .env — set DATABASE_URL (Neon pooled string) and ADMIN_USERNAME / ADMIN_PASSWORD

# 3. Push the schema + seed defaults
bun run db:push
bun run db:seed

# 4. Start the dev server
bun run dev
```

The dev server starts on <http://localhost:3000>.

Default admin login (change before deploy!): `admin` / `admin123`.

### Helper scripts

| Command | Purpose |
|---|---|
| `bun run db:push` | Create/alter tables (no migrations needed) |
| `bun run db:seed` | Seed default admin config (agents, flags, glossary, UX config) |
| `bun run gen-vapid` | Generate VAPID keypair for Web Push |
| `bun run gen-icons` | Regenerate PNG PWA icons from the SVG mark |
| `bun run hash-password <pw>` | bcrypt-hash the admin password |
| `bun run lint` | ESLint check |

### Verifying the install end-to-end

1. `/admin` → log in → **Agents** tab → set your API key (presets available) → **Test connection**.
2. **Users** tab → create a user `demo` / `demo123`.
3. `/` → log in as `demo` → set MPIN `1234`.
4. In chat, type: `aaj 20rs rapido ke kharch hue`
   - Agent calls `log_expense(amount=20, category=Transport)` and replies "Logged Rs 20 for Transport."
5. Try an analytical question: `3 months ago how much money did I send?` or `kitna balance hai?`
   - Agent uses date-range tools / live balances, may offer a chart.
6. Try a reminder: `remind me at 9:10pm daily with my day's totals`
   - Agent calls `create_scheduled_notification(type=daily, time=21:10, message=...)`.
7. `/dashboard` → log in again → Accounts → **Copy AI prompt** → paste into any chatbot →
   **Import data** → paste the result → review → import.

---

## Production deployment

### Step 1 — Provision Neon Postgres

1. Sign up at <https://neon.tech> (free tier: 0.5 GB storage).
2. Create a project; pick the region closest to your Vercel deployment.
3. Copy the **pooled** connection string (`...-pooler...` host) with `?sslmode=require`.

### Step 2 — Deploy to Vercel

1. Push the repo to GitHub → Vercel → **New Project** → import.
2. Set the environment variables (see table below).
3. Deploy, then run the schema push + seed **once** against Neon:

   ```bash
   DATABASE_URL='postgresql://...?sslmode=require' bun run db:push
   DATABASE_URL='postgresql://...?sslmode=require' bun run db:seed
   ```

### Environment variables

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | **Yes** | Neon Postgres connection string (pooled, `?sslmode=require`) |
| `ADMIN_USERNAME` | **Yes** | Admin panel username |
| `ADMIN_PASSWORD` | **Yes** | Plain text OR bcrypt hash (`$2b$...`) — preferred |
| `NEXT_PUBLIC_APP_URL` | Recommended | `https://khata.namansoni.in` — SEO metadata, sitemap, QStash callback URLs |
| `NEXT_PUBLIC_RP_ID` | For WebAuthn | `khata.namansoni.in` — otherwise auto-derived from the request host |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | For push | VAPID public key (`bun run gen-vapid`) |
| `VAPID_PRIVATE_KEY` | For push | VAPID private key |
| `VAPID_SUBJECT` | For push | e.g. `mailto:you@example.com` |
| `QSTASH_TOKEN` | For reminders | Upstash QStash token — enables per-reminder exact-time schedules |
| `QSTASH_CURRENT_SIGNING_KEY` | Recommended | Verifies Upstash-signed cron requests |
| `QSTASH_NEXT_SIGNING_KEY` | Recommended | Same, for key rotation |

### Step 3 — Configure VAPID keys (Web Push)

```bash
bun run gen-vapid
# → set NEXT_PUBLIC_VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY + VAPID_SUBJECT in Vercel → redeploy
```

### Step 4 — Configure Upstash QStash (scheduled notifications)

Reminders are delivered by **Upstash QStash** (works on Vercel free — no Vercel cron needed):

1. Sign up at <https://upstash.com> → QStash.
2. Copy **Token** + **Current Signing Key** + **Next Signing Key** into Vercel env vars.
3. **Exact-time delivery (automatic):** with `QSTASH_TOKEN` set, every recurring reminder
   registers its own QStash schedule (IST time auto-converted to a UTC cron) hitting
   `/api/notifications/cron?rid=<id>` at the exact minute; one-time reminders use a delayed
   publish. Deleting/pausing a reminder cancels its QStash schedule.
4. **Catch-all poll (set up once, recommended):** QStash dashboard → Cron Jobs → Create:
   - **Cron expression**: `*/5 * * * *`
   - **URL**: `https://khata.namansoni.in/api/notifications/cron`
   - **Method**: POST

   This fires any reminder whose `nextRunAt` is due — a belt-and-suspenders fallback.
5. The cron endpoint verifies Upstash server signatures (JWT HS256 with your signing keys)
   and/or the `QSTASH_TOKEN` bearer — randoms can't spam your users.

### Step 5 — Import your existing accounts (optional but recommended)

1. `/dashboard` → Accounts → **Copy AI prompt** (copies `public/addingaccountsprompt.md`).
2. Paste it into ANY AI chatbot. It interviews you about accounts, balances, contacts,
   categories — and can fold in CSV data you paste/upload.
3. Copy the formatted block it produces → Accounts → **Import data** → paste → review → Import.
4. Fix anything left by asking the chat assistant ("update my SBI balance to 5000").

### Step 6 — Configure LLM agents (in `/admin`)

Each agent row has preset chips (Groq llama-3.3-70b recommended default; Gemma 3 works with the
tool-calling toggle OFF via JSON fallback; OpenAI/Anthropic/OpenRouter/DeepSeek all supported).
Enter the API key, Save, then **Test connection**.

- **Daily chat** — Groq llama-3.3-70b or OpenAI gpt-4o-mini
- **Dashboard analysis** — OpenAI gpt-4o or Anthropic Sonnet (strong multi-step reasoning)
- **STT** — leave on Native (free) or configure an OpenAI-compatible Whisper endpoint
- **OCR** — vision-capable only: gpt-4o, Sonnet, Gemini Flash

### Step 7 — Production checklist

- [ ] `ADMIN_PASSWORD` set to a bcrypt hash (not plain text)
- [ ] VAPID keys generated + set
- [ ] QStash token + signing keys set; catch-all `*/5 * * * *` cron on `/api/notifications/cron`
- [ ] `NEXT_PUBLIC_APP_URL=https://khata.namansoni.in` set (SEO + QStash callbacks)
- [ ] `NEXT_PUBLIC_RP_ID=khata.namansoni.in` set (WebAuthn on the production domain)
- [ ] All 4 agents configured + tested
- [ ] Feature flags reviewed (`/admin` → Flags): pdfUpload / ocr / sttNative / webPush / autoAppendTotals / defaultLanguage / replyDelayMs
- [ ] Context settings reviewed (`/admin` → Context): LLM vs RAG mode, txn window, chat history window
- [ ] End-to-end smoke: create user → set MPIN → log a txn → ask a balance question → set a reminder

---

## Architecture notes

### Reminders pipeline (QStash, Vercel-free friendly)

Reminder rows are calendar-shaped (`type/time/date/daysOfWeek/dayOfMonth`, all IST) with a
precomputed `nextRunAt` UTC timestamp. Delivery has two independent paths:

1. **Exact-time** — `src/lib/scheduler.ts` converts IST → UTC cron (India is UTC+5:30 year-round,
   so the math is deterministic) and registers a per-reminder QStash schedule; one-timers within
   6 days use QStash delayed publish.
2. **Catch-all poll** — a single `*/5` QStash cron fires every row where `nextRunAt <= now`,
   then advances `nextRunAt` (or deactivates one-timers). Legacy cron-string rows are migrated lazily.

The endpoint authenticates via Upstash server signatures (JWT HS256, Web Crypto — no extra
dependency) or the bearer token, and falls back to open only when no auth env vars exist (local dev).

### Import pipeline

`public/addingaccountsprompt.md` is a complete system prompt for ANY external chatbot: it
interviews the user (accounts → wallets → demat → contacts → categories), explicitly offers to
read CSV data, enforces plain-number INR + sign conventions, and emits one fenced markdown block
(or JSON). `src/lib/agent/import-parser.ts` auto-detects JSON / markdown tables / CSV, normalizes
types and money strings, then `detectConflicts()` diffs against existing entities. The dashboard
dialog previews everything, lets the user pick keep-mine / use-imported per conflict, and applies.

### Session model

| Cookie | TTL | Idle? | Notes |
|---|---|---|---|
| `daily_session` | 30 days | No (sliding) | MPIN or WebAuthn unlock; minimal friction |
| `dashboard_session` | 4 hours hard cap | **15 min idle** (any activity extends) | Re-entry required; protects sensitive aggregates |
| `admin_session` | 2 hours | No | Env-var auth; short for security |

### Tool-call reliability (no JSON leaks)

Three layers: (1) native tool-calling when supported; (2) a hardened inline-JSON fallback parser
(balanced-brace scan, fence stripping, trailing-comma repair, snake_case name heuristic so chart
JSON is never swallowed); (3) `sanitizeAssistantText()` strips any leaked tool-call object from
EVERY persisted/displayed assistant message. Chart markers are extracted server-side and ride in
message metadata — the bubble only ever shows clean markdown.

### Infinite context, pragmatically

Per call: system prompt (time + live balances + schema + recent txns) + last N chat messages
(admin-tunable). Beyond that: `search_chat_history` (keyword search over every stored message),
`retrieve_transactions` (semantic-ish scoring), `query_transactions`/`aggregate` (structured
filters with computed from/to dates). The UI paginates history 100 messages at a time on scroll-up.

### File map

```
prisma/schema.prisma                — models (liquid metadata on entities, structured reminders, user prefs)
scripts/seed.ts                     — default admin config (4 agents + flags + glossary + uxConfig)
scripts/gen-vapid.ts                — VAPID keypair generator
scripts/gen-icons.ts                — PNG PWA icon generator (sharp)
scripts/hash-password.ts            — bcrypt password hasher
public/addingaccountsprompt.md      — system prompt for external AI chatbots (import flow)
src/lib/admin-config.ts             — admin config accessors (cached 30s) + types
src/lib/llm/client.ts               — universal LLM client (OpenAI-compatible + Anthropic)
src/lib/llm/json-tool-parser.ts     — hardened tool-call extractor + reply sanitizer
src/lib/agent/loop.ts               — conversation loop (dedupe, sanitize, chartSpec persistence)
src/lib/agent/tools.ts              — tool implementations (+ search_chat_history)
src/lib/agent/tools-defs.ts         — tool JSON schemas (daily agent = full analytical kit)
src/lib/agent/prompt-builder.ts     — system prompt assembly (time + balances + date rules + chart powers)
src/lib/agent/chart-marker.ts       — shared [CHART:{...}] extractor
src/lib/agent/import-parser.ts      — JSON/markdown/CSV import parser + conflict detection
src/lib/scheduler.ts                — calendar reminders: IST→UTC math, nextRunAt, QStash REST client
src/lib/notifications/push.ts       — Web Push (VAPID) + message templates
src/app/api/chat/route.ts           — daily+dashboard chat, history pagination
src/app/api/dashboard/import/       — two-phase import (preview → apply)
src/app/api/notifications/cron/     — QStash delivery endpoint (signatures verified)
src/components/chat/Markdown.tsx    — chat markdown renderer
src/components/dashboard/           — DeepDiveChat, MultiPeriodChart, ImportDialog
src/components/mindmap/             — MindmapEditor (React Flow)
```

## License

Private project. Not for redistribution. Made with ❤️ by [Naman](https://github.com/NamanSoni78).
