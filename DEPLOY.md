# Deploying Khata — Vercel + Turso + Resend (khata.namansoni.in)

A ~15-minute walkthrough from zero to production.

---

## 0. Prerequisites

- GitHub repo with this project pushed
- Accounts: [Turso](https://turso.tech) (free DB), [Resend](https://resend.com) (free emails),
  [Upstash](https://upstash.com) (free QStash), [Vercel](https://vercel.com)

## 1. Database — Turso

1. Create a database (pick a region near India, e.g. `aws-ap-southeast-1`).
2. Open **`KHATA_DB_SETUP.ipynb`** (repo root) in Google Colab:
   - Upload the project zip to the notebook
   - Paste your **Database URL** (`libsql://…`) and **Auth Token** in the form cell
   - Run all cells → schema + defaults are pushed and verified
3. Keep the URL + token handy — they go into Vercel next.

> Local alternative (no Colab): `TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… bun run turso:setup`

## 2. Email — Resend (OTP + password reset)

1. In Resend → **Domains** → add `khata.namansoni.in` and add the DKIM/SPF DNS records it shows.
2. Create an API key (`re_…`).
3. Mail will be sent from **`Khata <no-reply@khata.namansoni.in>`**
   (override with `RESEND_FROM`). Free tier: 100 mails/day — plenty for OTPs.

## 3. Web Push keys (VAPID)

```bash
bun run gen-vapid
```

## 4. Vercel

Import the repo, then set these env vars (Production **and** Preview):

| Variable | Value |
|---|---|
| `DATABASE_URL` | `libsql://…` from Turso |
| `DATABASE_AUTH_TOKEN` | token from Turso |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | your /admin credentials (bcrypt hash preferred: `bun run hash-password <pw>`) |
| `NEXT_PUBLIC_APP_URL` | `https://khata.namansoni.in` |
| `RESEND_API_KEY` | `re_…` from Resend |
| `RESEND_FROM` *(optional)* | `Khata <no-reply@khata.namansoni.in>` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | from gen-vapid |
| `VAPID_SUBJECT` | `mailto:you@example.com` |
| `QSTASH_TOKEN` | token(s), **multiple allowed separated by `;`** |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | signing keys, same `;` order as tokens |

**Multi-account QStash:** create 2–3 free Upstash accounts, put each account's token and keys
in the same env var separated by `;` (order pairs them). Khata spreads recurring reminder
schedules across the pool and accepts inbound requests signed by any account.

Deploy. 🚀

## 5. DNS

Point `khata.namansoni.in` at Vercel (they show the `A`/`CNAME` records on project setup).
Also keep the Resend DKIM/SPF records in place.

## 6. First-run checklist

1. Open `https://khata.namansoni.in` → **Create account with Gmail** →
   OTP email arrives (check spam the first time) → set MPINs → chat works.
2. Open `/admin` → **Agents** tab → set your default LLM (e.g. Groq
   `https://api.groq.com/openai/v1` + key + `llama-3.3-70b-versatile`) → **Test connection**.
3. **Speech-to-Text** tab → leave engine `native` (free, device) or set an
   OpenAI-compatible endpoint. Paste either a base URL (`…/v1`) or the full
   `/audio/transcriptions` endpoint — wrong pastes are auto-corrected.
4. Users can now bring **their own keys** from `/dashboard/settings`.
5. Optional: in Upstash, create a QStash **cron** hitting
   `https://khata.namansoni.in/api/notifications/cron` every 5 minutes
   (catch-all poll; exact-time delivery already uses per-reminder schedules).

## 7. Operations

- **Schema changes:** edit `prisma/schema.prisma`, re-run the Colab notebook
  (it skips existing tables) or `bun run turso:setup`.
- **Reseed defaults:** re-run the notebook's setup cell (upserts only).
- **User issues:** `/admin` → Users → flip Active. Users self-signup with Gmail.
- **Logs:** Vercel → Deployments → Functions logs.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Signup says "email isn't configured" | `RESEND_API_KEY` missing in Vercel env |
| OTP mails in spam | complete Resend domain verification (DKIM/SPF) |
| 500 on login/chat | `DATABASE_URL`/`DATABASE_AUTH_TOKEN` wrong → check Turso token |
| Reminders don't fire | check `QSTASH_TOKEN` + the catch-all cron (step 6.5) |
| "The assistant isn't set up yet" | configure the daily agent in `/admin` |
