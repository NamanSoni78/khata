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
| `APP_URL` | `https://khata.namansoni.in` — **recommended** (plain runtime var; always read at runtime, never build-inlined) |
| `NEXT_PUBLIC_APP_URL` | `https://khata.namansoni.in` — optional; ⚠️ build-time-inlined on Vercel: **editing it does nothing until you redeploy**, and quoted/pasted values can defeat naive normalization. V1.2 no longer depends on it for QStash destinations (they're derived from the live request headers) |
| `RESEND_API_KEY` | `re_…` from Resend |
| `RESEND_FROM` *(optional)* | `Khata <no-reply@khata.namansoni.in>` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | from gen-vapid |
| `VAPID_SUBJECT` | `mailto:you@example.com` |
| `QSTASH_TOKEN` | token(s), **multiple allowed separated by `;`** |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | signing keys, same `;` order as tokens — **optional since V1.6** (scheduled fires authenticate via the `&k=` URL key baked into every schedule destination; signing keys remain a recommended defense-in-depth) |

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
| Reminders don't fire | V1.6: fire requests self-authenticate via the `&k=` URL key — check Vercel logs for `[cron] reminder … fired → sent N device(s)`; `[cron] auth rejected` lines say exactly which credential was missing |
| "The assistant isn't set up yet" | configure the daily agent in `/admin` |

### Notifications checklist (V1.6)

1. **Server log shows `[qstash] schedule create failed … invalid destination url`**
   → FIXED FOR REAL in V1.5. The two earlier fixes addressed the URL *content*;
   the actual bug was the **wire format**: schedule creation POSTed a JSON body
   `{destination, cron}` to `/v2/schedules`, but the real QStash API takes the
   destination URL **raw in the request path** (`POST /v2/schedules/<full-url>`)
   with the cron in the `Upstash-Cron` header (verified against the official
   `@upstash/qstash` SDK's `Schedules.create()`). V1.5+ sends the correct form,
   and a successful create now logs
   `[qstash] schedule created (acct 0): schd… → https://khata.namansoni.in/api/notifications/cron?rid=…&k=… (cron "30 14 * * *")`
   so you can SEE it working in Vercel logs.

2. **"Schedule created successfully, but the notification never came"**
   → THE V1.6 ROOT CAUSE, fixed. QStash fire requests arrive at
   `/api/notifications/cron` with **no bearer token** — only an
   `Upstash-Signature` header, which the route could only verify if
   `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` were set. With only
   `QSTASH_TOKEN` configured (the common setup), **every scheduled fire was
   401-rejected by our own endpoint** — schedules fired on time at Upstash and
   bounced off our door, so the reminder never delivered. Test notifications
   kept working because they never pass through the cron route — exactly the
   "schedule created + test sent + nothing arrived" symptom.

   V1.6 fixes this with **no new env vars**: every schedule destination URL now
   carries `&k=<HMAC(rid, QSTASH_TOKEN)>` — a fire credential minted when the
   schedule is created and verified on arrival. Existing pre-V1.6 schedules
   (created without the key) are **migrated automatically** by the repair pass
   — open the dashboard Reminders tab once after deploying (or wait for the
   next catch-all tick) and watch Vercel logs for
   `[qstash] migrating pre-V1.6 schedule …` followed by
   `[qstash] schedule created …&k=…`. Setting the signing-key env vars is now
   OPTIONAL (still recommended as defense-in-depth — the route accepts either
   auth method).

3. **"Sent to 1 device" but no notification appeared**
   → V1.6 makes this **diagnosable on-device** instead of a guess:
   - **Send test is now echo-verified**: right after sending, the app waits
     15s for the service worker's receipt echo and tells you which of the two
     real causes it was — *received-but-not-seen* (OS notification settings /
     Focus Assist / DND — the app tells you the exact OS-specific fix) or
     *not-received-at-all* (the push went to a different browser — the device
     list says which).
   - **Notification doctor**: dashboard → Reminders → **Check** runs a live
     checklist on the device: browser support, iOS installed-app requirement,
     permission, service-worker **version** (a stale worker from before the
     deploy is detectable), this device's subscription, VAPID key match (the
     post-redeploy silent killer), server-side registration, and the last push
     receipt (proof the browser actually received one).
   - **In-page fallback**: while the app is open, every push that reaches the
     browser ALSO toasts inside the page — an OS-level mute can no longer make
     reminders completely invisible.
   - **Boot auto-heal**: on every load the app silently re-subscribes/re-saves
     this device when the server lost the subscription or the push keys
     changed (and the service worker handles `pushsubscriptionchange`
     rotation on its own).
   - Reminders now travel with `urgency: high` (wakes sleeping devices) and a
     24h TTL.

4. **"Enable notifications" / "Send test" did nothing**
   → fixed in V1.2 (the service worker was never registered before). After
   redeploying, reload the app once, then Settings → Enable notifications →
   Send test. The test now reports the TRUTH ("No device is subscribed…")
   instead of a fake "Sent!".
5. **Permission prompt** fires automatically the moment you set any
   notification (dashboard Schedule/Resume buttons, or "remind me at 8pm"
   in chat). If the browser already blocked notifications, unblock via the
   lock icon → Notifications → Allow, then reload.
6. **Subscriptions are per-device**: enable on every device you want
   notifications on. The dashboard's reminders tab shows each device's
   status and has its own Send-test button.
7. **QStash env hygiene (V1.5)**: tokens pasted with stray whitespace or
   wrapped across lines are auto-cleaned; the destination URL is swept for
   whitespace before ever reaching QStash. Multiple accounts stay separated
   by `;` in `QSTASH_TOKEN`.
8. **Security note (V1.6)**: the old `X-Internal-Scheduler: 1` header no
   longer authorizes cron requests (its value was public — anyone could
   trigger the catch-all poll with it). The app's own browser poll now
   authenticates with the user's session; fire requests authenticate via the
   URL key or the Upstash signature.
