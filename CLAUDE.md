# SRS Trading App — working rules

Steel trading app: orders with cut lengths, weight from size, cutting charge, weighing,
GST (pakka) / no-bill (kacha) billing, advances, khata (customer account book), slip numbers.
Used by shop staff and the owner's father — simplicity and correct numbers matter more than anything.

Design docs live in the claude.ai project "SRS trading application":
`claude/agreed-business-rules.md`, `claude/production-architecture.md` (v2), `claude/dev-environment.md`.

## Hard rules
1. **Never edit `prototype/v6/`.** It is the frozen, approved Version 6 (tag `prototype-v6`) and the reference for every number.
2. **All business maths lives in `packages/core`** (no DOM, no Supabase, no Capacitor imports). The app, the backend and the tests all use it.
3. **Parity tests must stay green.** `packages/core/test/parity.test.js` runs the real prototype and compares. If a number must change on purpose, record it in `docs/KNOWN-ISSUES.md`, get the owner's OK, and change the test in the same commit with the reason.
4. **Dates use the shop's time zone** (`Asia/Kolkata` default), never the device or server clock.
5. **Never commit secrets.** `.env` holds the Supabase access token and is git-ignored — check `git status` before every commit. Never print or paste tokens.
6. **Database changes only through versioned migrations** in `supabase/migrations/` (from Milestone 2). No manual dashboard edits to staging/production.
7. **Nothing is readable until a login session is unlocked with the PIN** (`docs/LOGIN.md`). Dev test phone numbers must never reach production.
8. **Screens never write money-related tables directly** — they call domain operations (createOrder, recordWeight, finalizeOrder, recordPayment, …) that the backend validates (from Milestone 4).

## Commands
- `npm test` — all core tests on Indian time (full prototype comparison).
- `npm run test:utc` — same tests with a UTC clock (as on a server).
- `npm run db:status` / `db:migrate` / `db:test` / `db:replay-check` — database (see `docs/DATABASE.md`).
- `npm run auth:e2e` — real login flow (dev test numbers); `npm run functions:deploy` — deploy Edge Functions.
  They talk to the dev project over HTTPS using the token in `.env`; `NODE_USE_ENV_PROXY=1` is set in the
  scripts so Node's fetch goes through the shell's proxy.

## Layout
- `prototype/v6/` — frozen prototype (reference only)
- `packages/core/` — business rules + tests
- `supabase/migrations/` — the database, built only from these files (append-only)
- `supabase/tests/` — database tests (always rolled back)
- `scripts/` — migration and database-test tools
- `docs/` — database guide, known issues and technical notes
- `.github/workflows/ci.yml` — runs the tests on every push
