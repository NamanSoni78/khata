# Finance Tracker PWA

A production-grade multi-tenant personal finance tracker built as a PWA on Next.js 16 + Prisma + Neon serverless Postgres.

Three routes, three threat models:

| Route | Auth | Idle timeout | Use case |
|---|---|---|---|
| `/` | Username + MPIN or WebAuthn passkey | 30 days | Daily expense logging via chat / voice (Hinglish-aware) |
| `/dashboard` | Username + password (re-entry required) | **15 minutes idle** (active sessions auto-extend) | Weekly deep-dive: budgets, multi-period charts, AI agent, mindmap editor, exports |
| `/admin` | `ADMIN_USERNAME` / `ADMIN_PASSWORD` env vars | 2 hours | Developer panel: per-agent LLM config, feature flags, system prompts, glossary, users, DB status |

## Highlights

- **Hinglish-aware transaction parsing** — understands natural multi-leg scenarios like
  *"Shorya ne 30 hazar diye IPO ke liye SBI mein, pichle IPO ka 10k profit PNB mein hai"* and
  logs all 4 legs (income → IPO investment → event → profit) as one linked transaction group.
- **Per-agent model picker** — admin chooses provider + model per agent (daily chat / dashboard analysis / STT / OCR).
  Three protocols supported: **OpenAI-compatible** (Groq, OpenAI, DeepSeek, OpenRouter, LM Studio),
  and **Anthropic-native**. Models without native tool-calling (e.g. Gemma) get a built-in JSON fallback mode.
- **Liquid schema** — agent can create accounts / contacts / categories mid-conversation; admin can
  toggle between LLM mode (full schema in prompt) and RAG mode (on-demand retrieval, no vector DB).
- **Bank statement parsing** — upload PDFs or paste raw text; agent extracts transactions, runs
  duplicate detection (±5% amount + ±3 days), and asks clarifying questions before logging dups.
- **OCR (vision) extraction** — admin enables OCR + configures a vision-capable model (OpenAI gpt-4o,
  Anthropic Sonnet, or OpenRouter Gemini); users can then upload images of receipts / statements.
- **Multi-period charts** — day (hourly), week/month (daily), 3m/6m (weekly), 1y/custom (monthly).
- **Mindmap editor** — React Flow canvas with form-edit + agentic-edit + undo/redo + explicit Save.
  Agent proposes edits via `propose_mindmap_edit`; UI shows a review-apply-discard panel.
- **Dashboard AI deep-dive chat** — agent offers charts by appending a `[CHART:{...}]` marker;
  UI shows text reply first + a "📊 Show as chart" reveal button (text-first, chart-on-demand).
- **PDF + CSV exports** — server-side PDFKit-generated, paginated, striped rows.
- **Web Push notifications** — VAPID + service worker + Upstash QStash cron (5-min interval).
- **WebAuthn passkeys** — register fingerprint / Face ID / hardware key as alternative daily unlock.
- **PWA installable** — manifest + service worker (app-shell cache, push listener, background sync).

## Tech stack

- **Frontend**: Next.js 16 App Router, Tailwind CSS, shadcn/ui, Recharts, React Flow (`@xyflow/react`)
- **Backend**: Next.js API routes (server actions), Prisma ORM, Neon serverless Postgres (SQLite in dev)
- **LLM clients**: OpenAI-compatible (Groq/OpenAI/DeepSeek/OpenRouter/LM Studio) + Anthropic-native, with a JSON fallback for models without tool-calling
- **Auth**: Auth.js credentials + `@simplewebauthn/server` + bcrypt MPIN
- **PDF**: `pdf-parse` (input) + `pdfkit` (export)
- **Push**: `web-push` + VAPID + Upstash QStash
- **Voice**: Web Speech API (default) or OpenAI-compatible Whisper-style endpoint (admin-configurable)

---

## Local development

### Prerequisites

- **Node.js 18+** (or **Bun** — preferred, the repo uses `bun.lock`)
- **Git**
- An LLM API key for at least one provider (Groq has a free tier)

### First-time setup

```bash
# 1. Install deps
bun install   # or: npm install

# 2. Copy .env and edit if needed
cp .env.example .env  # (or just use the existing .env — already set for dev)
# Edit .env to set ADMIN_USERNAME / ADMIN_PASSWORD before first deploy

# 3. Push the SQLite schema + seed defaults
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
| `bun run db:push` | Create/alter tables (no migrations needed in dev) |
| `bun run db:seed` | Seed default admin config (agent defaults, glossary, feature flags) |
| `bun run db:reset` | Drop + recreate everything (DESTRUCTIVE) |
| `bun run gen-vapid` | Generate VAPID keypair for Web Push |
| `bun run hash-password <pw>` | bcrypt-hash a password (for `ADMIN_PASSWORD` env var) |
| `bun run lint` | ESLint check |
| `bun run build` | Production build |

### Verifying the install end-to-end

After `bun run db:seed`, the admin panel defaults to Groq llama-3.3-70b with an empty API key —
set your key in `/admin > Agents` first. Smoke-test:

1. Go to <http://localhost:3000/admin>, log in with `admin` / `admin123`.
2. Go to **Users** tab → create a user `demo` / `demo123`.
3. Go to <http://localhost:3000/> → log in as `demo` / `demo123` → set MPIN `1234`.
4. In chat, type: `aaj 20rs rapido ke kharch hue`
   - Agent should call `log_expense(amount=20, category=Transport)` and reply "Logged Rs 20 for Transport."
5. Go to <http://localhost:3000/dashboard> → log in again with `demo` / `demo123`.
   - You should see the Rs 20 Transport expense in the current-month summary + recent transactions table.

---

## Production deployment

### Step 1 — Provision a Neon Postgres database

1. Sign up at <https://neon.tech> (free tier is enough to start — 0.5 GB storage, unlimited projects).
2. Create a new project; pick the region closest to your Vercel deployment region.
3. Copy the connection string. It looks like:
   ```
   postgresql://user:password@ep-xxx-xxx-pooler.region.aws.neon.tech/dbname?sslmode=require
   ```
   Use the **pooled** connection string for the app (the `-pooler` hostname).

### Step 2 — Switch Prisma to Postgres

Edit `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"   // was "sqlite"
  url      = env("DATABASE_URL")
}
```

The schema is portable: all JSON-ish fields are stored as `String` and use `JSON.stringify` / `JSON.parse`
in app code, so no schema changes are needed when switching providers. No enums (Postgres-compatible).

### Step 3 — Deploy to Vercel

1. Push your repo to GitHub.
2. Go to <https://vercel.com> → **New Project** → import the repo.
3. Vercel auto-detects Next.js. Set:
   - **Framework Preset**: Next.js
   - **Build Command**: `bun run build` (or `npm run build`)
   - **Output Directory**: `.next` (default)
4. In **Settings → Environment Variables**, add (see table below for full list):

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | **Yes** | Neon Postgres connection string (with `?sslmode=require`) |
| `ADMIN_USERNAME` | **Yes** | Admin panel username (for `/admin`) |
| `ADMIN_PASSWORD` | **Yes** | Plain text OR bcrypt hash (`$2b$...`) — preferred |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | For push | VAPID public key (run `bun run gen-vapid` locally to generate) |
| `VAPID_PRIVATE_KEY` | For push | VAPID private key |
| `VAPID_SUBJECT` | For push | E.g. `mailto:admin@example.com` |
| `NEXT_PUBLIC_RP_ID` | For WebAuthn | Your domain (e.g. `yourapp.vercel.app`) — otherwise auto-derived |
| `QSTASH_TOKEN` | For scheduled notifs | Upstash QStash token (see Step 5) |
| `QSTASH_CURRENT_SIGNING_KEY` | For QStasth signature verification | From Upstash console |
| `QSTASH_NEXT_SIGNING_KEY` | For QStash key rotation | From Upstash console |

5. Deploy. Vercel runs `prisma generate` automatically as part of `postinstall` (Prisma is a dep).
6. After first deploy, run the schema push + seed **once** against the Neon DB:

   ```bash
   # From your local machine, with DATABASE_URL pointing at Neon:
   DATABASE_URL='postgresql://...?sslmode=require' bun run db:push
   DATABASE_URL='postgresql://...?sslmode=require' bun run db:seed
   ```

   Or use Vercel's CLI: `vercel env pull .env.production.local && bun run db:push && bun run db:seed`.

### Step 4 — Configure VAPID keys (Web Push)

1. Generate a VAPID keypair locally:
   ```bash
   bun run gen-vapid
   # Prints:
   # NEXT_PUBLIC_VAPID_PUBLIC_KEY=BPxxxxxxxxxxxxxxxxxxxxxxxxxx
   # VAPID_PRIVATE_KEY=xxxxxxxxxxxxxxxxxxxxx
   ```
2. In Vercel **Settings → Environment Variables**, add:
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (must be prefixed with `NEXT_PUBLIC_` so the browser sees it)
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT=mailto:you@yourdomain.com`
3. Redeploy. Users can now subscribe to push notifications in the daily app's Settings sheet.

### Step 5 — Configure Upstash QStash (scheduled notifications)

The app exposes `POST /api/notifications/cron` which fires any due `ScheduledNotification`s.
You need a cron to hit this every 5 minutes.

1. Sign up at <https://upstash.com> → QStash.
2. From the QStash dashboard, copy the **Token** + **Current Signing Key** + **Next Signing Key**.
3. Add them to Vercel env vars (`QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`).
4. In QStash dashboard → **Cron Jobs** → **Create**:
   - **Cron expression**: `*/5 * * * *` (every 5 minutes — minimum allowed interval)
   - **URL**: `https://yourapp.vercel.app/api/notifications/cron`
   - **Method**: POST
5. QStash signs each request with HMAC; the cron endpoint verifies the signature (if `QSTASH_CURRENT_SIGNING_KEY`
   is set) before firing notifications — so a malicious actor can't spam your users by hitting the URL.

### Step 6 — Configure LLM providers (in `/admin`)

After deploy, log into `/admin` and configure your LLM agents. Each agent has a row of preset chips:

**General agents (daily chat, dashboard analysis, STT):**
- **Groq llama-3.3-70b** — free tier, native tool-calling, excellent reasoning (recommended default for production).
- **Gemma 3 27B (Groq)** — free, no native tool-calling — flip the "tool calling" toggle OFF and the JSON fallback mode kicks in.
- **Groq llama-3.1-8b** — free, ultra-fast, best for STT-like low-latency tasks.
- **OpenAI gpt-4o** — paid, best reasoning + vision-capable. Best for dashboard deep-dive + mindmap agentic edits.
- **OpenAI gpt-4o-mini** — paid, ~30x cheaper than gpt-4o, good balance for daily chat.
- **OpenAI o3-mini** — paid reasoning model. Uses `max_completion_tokens` (auto-set by preset).
- **Anthropic Sonnet / Haiku** — paid, native tool-calling, Sonnet is vision-capable for OCR.
- **DeepSeek V3** — paid, very cheap, strong reasoning. Note: hosted in China — verify data residency.
- **OpenRouter Gemini 2.5 Flash** — paid, multimodal (vision-capable for OCR), cheap.

**OCR agent (vision-capable only):**
- OpenAI gpt-4o, gpt-4o-mini, Anthropic Sonnet, OpenRouter Gemini 2.5 Flash.

Click a preset to fill the form. Enter your API key separately. Click **Save**, then **Test connection**.

### Step 7 — Production checklist

- [ ] `ADMIN_PASSWORD` set to a bcrypt hash (not plain text) — run `bun run hash-password` locally
- [ ] VAPID keys generated + set as Vercel env vars
- [ ] QStash cron hitting `/api/notifications/cron` every 5 minutes
- [ ] `NEXT_PUBLIC_RP_ID` set to your domain (so WebAuthn works on the production domain)
- [ ] All 4 agents configured in `/admin`:
  - [ ] Daily chat — recommend Groq llama-3.3-70b or OpenAI gpt-4o-mini
  - [ ] Dashboard analysis — recommend OpenAI gpt-4o or Anthropic Sonnet (strong multi-step reasoning)
  - [ ] STT — leave on Native (Web Speech API) for free, or switch to Groq llama-3.1-8b + Whisper endpoint
  - [ ] OCR — OpenAI gpt-4o (best on dense Indian bank statements) or Gemini 2.5 Flash (cheap)
- [ ] Feature flags set in `/admin`:
  - [ ] `pdfUpload` ON (if you want bank statement PDFs)
  - [ ] `ocr` ON (if you configured a vision agent above)
  - [ ] `sttNative` ON (or OFF if you configured an OpenAI-compatible STT endpoint)
  - [ ] `webPush` ON (if VAPID configured)
  - [ ] `autoAppendTotals` ON (recommended — appends today/month totals to each chat reply)
  - [ ] `defaultLanguage` — set to `english` (default), `hinglish`, or `hindi`
- [ ] Schema-in-context mode chosen (in `/admin` → Context/Time):
  - [ ] **LLM mode** (recommended for users < 5k txns — faster, no extra round-trips)
  - [ ] **RAG mode** (only for users with 5k+ txns — saves tokens, adds latency for historical queries)
- [ ] Glossary reviewed (66 finance terms seeded by default — IPO, SIP, FD, demat, etc.)
- [ ] Test the full flow end-to-end: create user → set MPIN → log a txn via chat → view in dashboard

---

## Architecture notes

### Why dual LLM protocol (OpenAI-compatible + Anthropic)?

The user (developer) wants full control over which model powers each agent. Per-agent config means:
- Daily chat can use Groq llama-3.3-70b (cheap, fast, native tool-calling)
- Dashboard analysis can use OpenAI gpt-4o (expensive, strongest reasoning, vision-capable)
- STT can use native Web Speech API (free) or Groq + Whisper-style endpoint
- OCR uses whatever vision-capable model admin picks (OpenAI gpt-4o / Anthropic Sonnet / Gemini)

The Anthropic-native API differs enough from OpenAI's that a thin shim is needed (different message
format, different tool-call envelope, `max_tokens` is required not optional). The client handles both.

Models without native function-calling (Gemma and friends) get a JSON fallback mode: the agent
config's "tool calling supported" toggle is flipped OFF, the model is instructed to emit
`{"tool_call":{"name":"...","arguments":{...}}}` inline, and the `parseJsonToolCalls` helper
(in `src/lib/llm/json-tool-parser.ts`) strips markdown fences, scans for balanced `{...}` objects,
parses each, and accumulates multiple tool calls. Handles nested args (e.g., `propose_mindmap_edit`
with `nodes:[{...},{...}]` arrays) correctly.

### Why Neon (vs Supabase / Turso)?

- **Neon**: serverless Postgres with branching, generous free tier (0.5 GB), built-in pooling.
- **Supabase**: also fine, but adds an opinionated auth + storage layer (we already have our own).
- **Turso**: SQLite at the edge — tempting, but no real Postgres features (CTEs, JSONB operators) we might want later.

### Session model

Three separate session cookies, three separate timeouts:

| Cookie | TTL | Idle? | Notes |
|---|---|---|---|
| `daily_session` | 30 days | No (sliding) | MPIN or WebAuthn unlock; minimal friction |
| `dashboard_session` | 4 hours hard cap | **15 min idle** (any activity extends) | Re-entry required; protects sensitive aggregates |
| `admin_session` | 2 hours | No | Env-var auth; short for security |

The dashboard's idle timeout is enforced server-side (each request checks `lastActivity`); any
activity (API call, page nav) extends it. So an active analyst won't get kicked out, but a parked
tab will after 15 minutes.

### Liquid schema

The agent can create accounts / contacts / categories mid-conversation. The Prisma schema has a
`metadata String @default("{}")` on every major entity for ad-hoc custom fields (e.g., `rawText`
from bank statement uploads, `eventType` for non-financial events, `deviceType` for WebAuthn creds).
Admins can edit the system prompts to teach the agent new patterns without code changes.

### Multi-leg transaction groups

A single user message can produce multiple `log_expense` / `log_income` / `mark_event` tool calls
that share a `group_label`. The agent loop auto-links any txns created in the same turn (even if
the LLM forgets `group_label` on some legs) by scanning the result strings for `Txn ID: xxx` and
linking them to the first-seen group. The dashboard agent can then call `get_group_summary(label)`
to answer "tell me about Shorya's IPO plan" with a structured breakdown.

### Mindmap agentic edit flow

1. User opens `/dashboard` → Mindmap Editor → selects a mindmap.
2. User types a request in the chat panel: "reorganize my budget mindmap with income and expenses as children of a root node".
3. UI posts to `/api/dashboard/deep-dive` with the current nodes/edges as context.
4. Agent calls `propose_mindmap_edit(id, nodes, edges, summary)` — full proposed graph (not a patch).
5. The tool returns the proposed graph as JSON. UI parses it and shows a **review panel**:
   "Agent proposed: 'Reorganized with root node'. [Apply] [Discard]".
6. Clicking **Apply** copies the proposal to the canvas — but does NOT save.
7. Undo/redo work on the canvas state (snapshots of `{nodes, edges}`).
8. **Save** commits the full current state (PUT replace).

This matches the user's explicit requirement: "explicit save, with undo/redo".

### Chart-on-demand

The dashboard agent is instructed (via system prompt) to emit a `[CHART:{...}]` marker AFTER
its textual reply when a chart would help. The `/api/dashboard/deep-dive` endpoint parses the
marker with a balanced-brace scanner (handles nested JSON like `data:[{label, value}]`) and
returns `{ reply, chartSpec, toolCalls }`. The UI shows the text reply, then a `<details>`
with "📊 Show as chart" reveal button — text first, chart on demand.

---

## File map

```
prisma/schema.prisma                — 15 models, SQLite+Postgres compatible
scripts/seed.ts                     — Default admin config (4 agents + flags + glossary)
scripts/gen-vapid.ts                — VAPID keypair generator
scripts/hash-password.ts           — bcrypt password hasher
scripts/e2e-verify.sh              — End-to-end API smoke test (login → MPIN → chat → dashboard)
scripts/test-phase3.sh             — End-to-end smoke test for Phase 3
src/lib/admin-config.ts            — Admin config DB accessors (cached 5 min)
src/lib/llm/client.ts              — Universal LLM client (3 providers)
src/lib/llm/presets.ts              — Curated model presets (chips in admin)
src/lib/llm/json-tool-parser.ts    — Robust JSON tool-call extractor (fallback mode)
src/lib/agent/loop.ts               — Conversation loop (max 5 tool-call iterations)
src/lib/agent/tools.ts             — 18 tool implementations
src/lib/agent/tools-defs.ts        — Tool JSON Schema definitions
src/lib/agent/prompt-builder.ts    — System prompt assembly (time + schema + flags + glossary)
src/lib/auth/credentials.ts         — bcrypt MPIN + password wrappers
src/lib/auth/session.ts            — 3 session types (daily / dashboard / admin)
src/lib/auth/webauthn.ts           — @simplewebauthn/server wrappers
src/lib/notifications/push.ts      — Web Push (VAPID) + placeholder templates
src/app/                           — Next.js App Router pages + API routes
src/components/dashboard/          — DeepDiveChat, MultiPeriodChart
src/components/mindmap/            — MindmapEditor (React Flow)
src/components/charts/             — InlineChart (Recharts bar/line/pie)
```

## License

Private project. Not for redistribution.
