# Finance Tracker PWA — Worklog

---
Task ID: phase-1
Agent: super-z (main)
Task: Build Phase 1 of finance tracker PWA — admin panel + LLM client + agent + daily chat PWA + dashboard + PWA shell. End-to-end verified.

Work Log:
- Initialized fullstack dev environment (Next.js 16 + Tailwind + shadcn/ui + Prisma + SQLite for sandbox; switch to Neon Postgres on deploy via `DATABASE_URL` env swap + `provider="postgresql"` in `prisma/schema.prisma`).
- Installed: bcryptjs, @simplewebauthn/server, @simplewebauthn/browser, web-push, idb + types.
- Wrote portable Prisma schema (SQLite + Postgres compatible): User, UserMpin, UserWebAuthnCredential, UserSession, Account, Contact, Category, Tag, TransactionTag, Transaction, TransactionGroup, PendingQuestion, ChatMessage, PushSubscription, ScheduledNotification, AdminConfig. All major entities have `metadata String @default("{}")` for ad-hoc custom fields (liquid schema).
- Wrote seed script (`scripts/seed.ts`) upserting AdminConfig defaults: agent.daily, agent.dashboard, agent.stt, agent.ocr, featureFlags, timeTemplate, schemaMode, glossary (66 terms).
- Built auth lib: credentials (bcrypt), sessions (daily 30d / dashboard 15-min idle + 4h cap / admin 2h), cookies, admin (env-var auth, plain or bcrypt).
- Built universal LLM client with 3 providers (OpenAI-compatible, Anthropic-native, ZAI SDK at the time).
- Built agent loop (max 5 tool iterations) + 18 tools + tool defs + prompt builder (time injection + schema-in-context).
- Built API routes: auth (login/logout/me/mpin/webauthn), chat, admin (login/logout/config/users/db-status/test-agent), dashboard (login/logout/stats), notifications (subscribe/vapid-public-key).
- Built pages: `/` daily app (login → MPIN setup → unlock → chat), `/dashboard`, `/admin`.
- PWA shell: manifest, service worker, icons.

Stage Summary:
- Phase 1 complete. App works end-to-end in sandbox with SQLite.

---
Task ID: phase-2-1 … phase-2-6
Agent: super-z (main)
Task: Phase 2 — multi-leg transactions, PDF statement parsing + duplicate detection, WebAuthn passkeys, Web Push notifications, RAG mode, OCR/vision extraction.

Work Log:
- Multi-leg txn groups: shared `group_label` across multiple log_* calls in one turn; auto-linking of txns created in the same turn.
- Statement upload endpoint (`/api/chat/upload-statement`): PDF parse → LLM extraction → duplicate detection (±5% amount + ±3 days) → confirm-before-log flow.
- WebAuthn: register/login begin+finish endpoints, passkey management in daily settings.
- Web Push: VAPID keypair gen script, subscribe endpoint, cron endpoint for scheduled notifications (QStash-compatible with HMAC signature verification).
- RAG mode: retrieve_transactions tool with keyword + bigram scoring (no vector DB).
- OCR: image upload → vision model extraction, gated by feature flags.

Stage Summary:
- Phase 2 complete (6/6 sub-tasks).

---
Task ID: phase-3
Agent: super-z (main)
Task: Phase 3 — Mindmap editor (React Flow: view + form-edit + agentic edit + undo/redo + explicit save), PDF/CSV exports, dashboard AI deep-dive chat with inline "show as chart" button, multi-period charts (day/week/month/3m/6m/1y/custom).

Work Log:
- Added Mindmap model + CRUD API + propose_mindmap_edit tool (full-replacement proposal, review-apply-discard flow).
- Deep-dive endpoint parses `[CHART:{...}]` markers (balanced-brace scan) → chartSpec returned to UI.
- Multi-period stats aggregation with adaptive bucket granularity.
- PDFKit export (paginated, striped rows) + CSV export.

Stage Summary:
- Phase 3 complete.

---
Task ID: phase-4
Agent: super-z (main)
Task: Phase 4 — ZAI fallback parser hardening, preset chips in admin, RAG mode UI polish, deployment README, agent loop duplicate-call detection + max_tokens fixes.

Work Log:
- Extracted fallback parser to standalone module with 10 unit tests (all passing).
- Preset catalogs (general + OCR vision-capable) with cost badges.
- Deployment README (Vercel + Neon + VAPID + QStash + env vars table + production checklist).
- Duplicate tool-call detection in agent loop; explicit max_tokens for ZAI; simplified mindmap tool schema with server-side normalization.

Stage Summary:
- Phase 4 complete. Project previously declared production-ready (see Phase 5 for the production-polish pass that followed).

---
Task ID: phase-5
Agent: super-z (main)
Task: Phase 5 — Production polish, continuing the user's downloaded project (khatabook-trial-main.zip). 5 goals: (1) remove all ZAI/sandbox SDK references for production; (2) complete UI/UX redesign fixing the black-bg/black-text conflict with a minimal, non-AI-looking, mobile-first design + subtle animations; (3) remove developer-facing text from client routes (`/` and `/dashboard`); (4) fix pre-existing bugs; (5) end-to-end verification.

Work Log:
- Downloaded + restored the user's project zip into the workspace; re-installed deps; pushed SQLite schema; re-seeded defaults.
- **ZAI removal (production cleanliness):**
  - Rewrote `src/lib/llm/client.ts`: removed the ZAI SDK provider entirely. Providers now: `openai-compatible` | `anthropic` only.
  - The JSON tool-call fallback (for models without native function-calling, e.g. Gemma) was KEPT but generalized: renamed `zai-parser.ts` → `json-tool-parser.ts`, `parseZaiToolCalls` → `parseJsonToolCalls`. New `chatCompleteJsonFallback` flattens tool-result messages into plain text turns any model can follow, works for BOTH providers, selected automatically when an agent's "tool calling supported" toggle is OFF.
  - Added `extraHeaders` to agent config (JSON string or object) — merged into every LLM request. Genuinely useful in production for OpenRouter (HTTP-Referer/X-Title) and gateway auth headers.
  - `presets.ts`: removed ZAI preset; added "Gemma 3 27B (Groq)" preset demonstrating the JSON-fallback mode (toolCallingSupported: false).
  - `admin-config.ts`: provider type narrowed; `extraHeaders?` added.
  - API routes (chat, upload-statement, deep-dive): removed `provider !== "zai"` checks; error messages made client-safe ("The assistant isn't set up yet. Please contact your administrator." instead of admin-panel instructions). Chat route no longer leaks provider/API errors to clients (logs server-side, returns generic 502 message).
  - `scripts/seed.ts`: defaults now Groq llama-3.3-70b (openai-compatible, empty key — admin sets their own). Re-seeded the DB.
  - Removed `z-ai-web-dev-sdk` from package.json; deleted sandbox-only test scripts (test-zai-*.ts, test-phase*.sh, etc.).
  - `README.md` / `DEPLOY.md`: all ZAI references rewritten.
- **Design system (globals.css):**
  - New warm light theme (paper white `oklch(0.982 0.004 106)` bg, warm ink text, emerald-700 primary — money green) + proper warm-charcoal dark theme (never pure black). Added `success`/`danger` tokens. Chart palette harmonized.
  - Subtle motion utilities (all 150–260ms, reduced-motion respected): `anim-msg-in` (chat bubbles), `anim-fade-up` + staggered variants, `anim-fade-in` (overlays), `anim-sheet-in` (bottom sheet), `anim-pop-in`, `.press` (button scale feedback), `.typing-dot` (3-dot indicator), `.anim-rec-pulse` (mic recording).
  - Thin quiet scrollbars, safe-area helpers (`.safe-top/.safe-bottom`), tabular numerals helper, tap-highlight removal, `overscroll-behavior-y: none` for app feel.
  - New app identity: "Khata — daily money diary". New SVG icons (emerald ₹ mark) replacing the old Z-branded logo; manifest + appleWebApp + theme-color updated (light + dark media queries); SW cache bumped to khata-v2.
  - Theme init script in layout.tsx applies saved theme before first paint (no FOUC). Theme toggle = CSS `dark:` variants (no state, no hydration issues).
- **DailyApp.tsx rewrite (mobile-first):**
  - Login / MPIN setup / unlock screens: centered cards, labeled inputs, token-based colors.
  - Chat: sticky header with status dot (online/offline/queued count), message bubbles with entrance animation, typing dots, auto-resizing textarea, example chips (tappable) on empty state, bottom settings sheet with slide-up animation.
  - NEW: chat history persistence — `GET /api/chat?action=history` returns recent messages; the app loads them on unlock so conversations survive reloads (was a gap before).
  - NEW: offline queue — messages sent while offline are stored in localStorage with a "queued" indicator and auto-flush when back online (user requirement #6).
  - Client-safe text everywhere ("Ask your administrator to create one", "Notifications aren't available on this deployment yet").
- **Dashboard rewrite (DashboardLogin / DashboardApp / SettingsApp):** token-based cards, donut chart with legend, delta chips, cleaned tables, reminders card without QStash/VAPID/cron dev text, removed "Phase 3 dashboard" footer, theme toggle.
- **Components:** DeepDiveChat (chat-style bubbles, suggestion chips, typing dots, removed the "tools called (N)" dev display), InlineChart (token-based, "Show as chart" reveal button), MultiPeriodChart (token-based), MindmapEditor (token-based, React Flow colorMode="system", review panel restyled).
- **AdminPanel/AdminLogin:** light theme, ZAI provider option removed (OpenAI-compatible + Anthropic only), extraHeaders input with OpenRouter hint, tool-calling toggle wording clarified, users tab with isolation note.
- **Pre-existing bug fixes:**
  - `webauthn.ts`: fixed @simplewebauthn/server v13 API breaks — `supportedCOSEAlgorithmIDs` → `supportedAlgorithmIDs`; registration result now read from `registrationInfo.credential.{id,publicKey,counter}`; removed invalid `rpName` from `generateAuthenticationOptions`. (These broke passkey registration at runtime.)
  - `upload-statement/route.ts`: pdf-parse v2 API — `(await import("pdf-parse")).default(buf)` → `new PDFParse({ data }).getText()` + destroy.
  - `admin.ts` 500 on admin login in fresh DBs (stale Prisma client issue resolved by server restart; code path verified).
  - `DailyApp.tsx`: `Uint8Array<ArrayBuffer>` typing fix for push subscription keys.
  - Created missing `POST /api/notifications/test` endpoint (UI called it; it didn't exist → 404).
  - Removed leftover dev `GET /api` "Hello, world!" route.
  - Admin config cache TTL 5min → 30s (config changes were invisible to separately-bundled route instances for up to 5 minutes).
  - Agent loop: failed LLM calls no longer leave orphan user messages in chat history (user message removed on error).
- **End-to-end verification (API + agent-browser + VLM design review):**
  - Admin login → configure agents via admin API (openai-compatible + extraHeaders) → test connection ✓ ("Connected. Model: glm-4-plus").
  - User creation → daily login → MPIN setup → chat: "aaj 20 rs rapido ke kharch hue" → log_expense(20, Transport) ✓.
  - Complex multi-leg Hinglish scenario (the user's exact test case): "mere dost shorya ne 30 hazar aaj 6 baje diye the ipo mein lagane ke liye sbi bank mein, osme se oska ipo select ho gya or pichle baar ke oske ipo ke profit ke 10k paise PNB bank mein hai" → 4 linked tool calls: log_expense(30000, IPO investment) + mark_event(IPO selected) + log_income(10000, Investment returns) + link_transactions, all grouped ✓. PNB account + Shorya contact auto-created with balances ✓.
  - Dashboard: stats (income 10,000 / expense 30,020 / net −20,020) ✓, CSV export ✓, PDF export (%PDF-1.3) ✓, deep-dive Q&A with real numbers ✓, chart spec generation ✓.
  - Browser (mobile 390×844 + desktop 1280×800): login → unlock → chat with history → live message → dashboard all sections → settings sheet → dark mode toggle (persisted) → admin panel (tabs, presets, no ZAI option). Zero console errors. VLM design review: "clean and professional… no black-on-black… excellent contrast" for light, dark, and dashboard views.
  - TypeScript clean, ESLint clean.

Stage Summary:
- Phase 5 complete. All 5 goals delivered:
  1. ZAI SDK fully removed (providers: OpenAI-compatible + Anthropic; JSON fallback kept as a first-class feature for non-tool-calling models; extraHeaders added).
  2. Complete UI redesign — warm light + dark themes, emerald accent, mobile-first, subtle 150–260ms animations, "Khata" identity.
  3. Client routes scrubbed of developer-facing text.
  4. Pre-existing bugs fixed (WebAuthn v13, pdf-parse v2, missing test endpoint, config cache, orphan messages, stale dev routes).
  5. Verified end-to-end: API flows + browser flows + visual review.
- New capabilities added along the way: chat history persistence, offline message queue, notifications test endpoint, theme toggle (light/dark).
- For production: user deploys to Vercel + Neon (README steps), sets ADMIN_USERNAME/ADMIN_PASSWORD + VAPID + QStash env vars, configures LLM agents in /admin (presets available), creates user accounts in /admin > Users.
