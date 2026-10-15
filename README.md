# Khata — daily money diary (khata-prodV1)

A WhatsApp-feel PWA where you log money by **chat or voice** (English / Hindi / Hinglish),
ask questions about your finances, set reminders, and dig into charts on a dashboard.

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind 4 · Prisma + **Turso (libSQL)** ·
Resend (email OTP) · Web Push (VAPID) + Upstash QStash · PWA.

---

## What's inside

| Route | What it is |
|---|---|
| `/` | The daily PWA. Sign up with **Gmail + OTP**, set a **4-digit MPIN**; on every return trip just the MPIN. WhatsApp-style chat with the assistant (voice, statements, charts, reminders). |
| `/dashboard` | Weekly deep-dive. Unlocks with a **6-digit dashboard MPIN** (or password). Charts, exports, mindmap editor, AI analysis chat. |
| `/dashboard/settings` | **Bring your own AI keys** — your own OpenAI-compatible base URL / key / model for the home chat, dashboard agent, speech-to-text and vision; plus custom instructions and MPIN management. |
| `/admin` | Operator panel (env-var auth): agent defaults, feature flags, users, glossary, context settings. |
| `/terms`, `/privacy` | Legal pages. |

### Highlights
- **Gmail-only accounts** (dots/+tag aliases rejected) with **OTP verification via Resend**,
  forgot-password flow, and MPIN-based returning login (4-digit app / 6-digit dashboard,
  brute-force lockout, reset with Gmail + password).
- **Turso database** via Prisma's official libSQL adapter — same code path locally (SQLite file)
  and in production (libsql://). Liquid schema: every entity carries a `metadata` JSON column.
- **User-owned AI**: per-user overrides (URL/key/model) on top of admin defaults — field-by-field
  merge; custom instructions per agent.
- **Two STT engines**: device-native (fixed duplication bug — idempotent transcript rebuilds)
  or any OpenAI-compatible `/audio/transcriptions` endpoint (recorded audio proxied server-side
  so keys never hit the browser). Wrong URL pastes (e.g. `/chat/completions`) are auto-corrected.
- **QStash multi-account pool** — put several accounts in the env vars (`;`-separated) and
  reminder schedules spread across them automatically.
- PWA: offline message queue, install prompt, doodle wallpapers, Web Push notifications,
  daily/weekly/monthly reminders with IST-exact delivery.

---

## Quick start (local)

```bash
bun install
cp .env.example .env        # set DATABASE_URL="file:./db/khata.db" for local
bun run db:push             # create local SQLite schema
bun run db:seed             # default admin config (agents, flags, glossary)
bun run dev
```

Open http://localhost:3000 → sign up (dev mode shows the OTP on screen when no
`RESEND_API_KEY` is set) → chat.

## Production deploy (Vercel + Turso)

1. **Turso**: create a DB at https://turso.tech, then run the **`KHATA_DB_SETUP.ipynb`**
   Colab notebook in this repo — upload the project zip, paste your DB URL + token,
   and it pushes the schema + seeds defaults automatically.
2. **Resend**: add + verify the `khata.namansoni.in` domain, create an API key.
3. **Vercel**: import the repo and set env vars (see `.env.example`):
   - `DATABASE_URL` + `DATABASE_AUTH_TOKEN` (from Turso)
   - `ADMIN_USERNAME` / `ADMIN_PASSWORD`
   - `NEXT_PUBLIC_APP_URL` = `https://khata.namansoni.in`
   - `RESEND_API_KEY` (+ optional `RESEND_FROM`)
   - VAPID keys (`bun run gen-vapid`) + `VAPID_SUBJECT`
   - QStash token + signing keys (multi-account supported, `;`-separated)
4. Deploy, open `/admin`, configure the LLM agents (Groq/OpenAI/OpenRouter/Anthropic…),
   and you're live.

Detailed walkthrough: **DEPLOY.md**.

---

## Voice input

- **Device engine (default, free):** works offline-ish on Chrome/Android, best for Hinglish
  with `en-IN`. The transcript rebuild strategy makes duplicate-word bugs impossible.
- **OpenAI-compatible engine:** set by the admin or per-user in dashboard settings
  (base URL / key / model). Audio is recorded in the browser and proxied through
  `/api/stt/transcribe`, so API keys stay server-side.

## Project layout

```
src/app/                    routes: /, /dashboard, /admin, /terms, /privacy
src/app/components/         AuthScreens, PinField, Keypad (auth + OTP/PIN UI)
src/lib/toolkit/            THE TOOL-CALLING SDK (see below)
src/lib/                    db (Turso adapter), email (Resend+OTP), user-config
                            (BYO-key resolution), qstash-pool, scheduler, agent/, llm/
scripts/                    seed, turso-setup, gen-vapid, gen-icons, test-toolkit,
                            test-pipeline, e2e-test
KHATA_DB_SETUP.ipynb        one-click Colab schema push to Turso
prisma/schema.prisma        sqlite provider + driverAdapters (works for Turso + local)
```

## The tool-calling SDK (`src/lib/toolkit/`)

The agent's tool calling is engineered to **never fail the turn**. Eight layers,
each catching what the previous one misses:

| Layer | Module | What it heals |
|---|---|---|
| Transport | `transport.ts` | 429 / 5xx / network errors — timeout + exponential backoff + Retry-After |
| Providers | `providers.ts` | OpenAI-compatible + Anthropic; native tool args kept raw (no risky `JSON.parse`) |
| JSON repair | `json-repair.ts` | truncated, single-quoted, unquoted keys, trailing commas, comments, Python-isms |
| Schema | `schema.ts` | type coercion (`"20rs"`→20, `"₹1,200"`→1200, `"true"`→true) + model-readable validation errors |
| Registry | `registry.ts` | hallucinated names (`logExpense` → `log_expense`) via alias + Levenshtein fuzzy matching |
| Executor | `executor.ts` | never-throw execution envelopes with per-tool timeouts |
| Agent loop | `agent-loop.ts` | self-correction feedback, duplicate guards, loop-stuck detection, auto-degradation to JSON mode when an endpoint rejects `tools` |
| Sanitizer | `parse.ts` | users never see leaked `{"tool_call":…}` JSON in chat bubbles |

Run the adversarial test suite (85 assertions incl. a mock-provider e2e):

```bash
bun run scripts/test-toolkit.ts   # 85/85
bun run scripts/test-pipeline.ts  # 14/14 — live API + DB with deliberately broken tool args
```

## Notes & disclaimers

- Emails come from `no-reply@khata.namansoni.in` (configurable via `RESEND_FROM`).
- MPIN brute force is throttled server-side (5 tries → 10-minute lock).
- The service is provided as-is — see `/terms` and `/privacy`.
