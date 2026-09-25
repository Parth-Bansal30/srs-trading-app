# Database guide (Milestone 2)

PostgreSQL on Supabase. Dev project: `srs-trading-dev` (Mumbai). Built only from the files in
`supabase/migrations/` — never by hand in the dashboard.

## The big rules (enforced by the database itself)
1. **Every company's data is separate.** Every company-owned row has `company_id`; links between
   tables include `company_id`, so a row can never point at another company's data.
2. **Signed-in users can only read, only their own company, and only after unlocking with their PIN.** Row Level Security is on for
   every table. All changes go through backend domain operations (Milestone 4).
3. **Who sees what** (from each person's permissions):
   - grade names and customers: every staff member
   - rates: `money` or `rates`
   - orders, items, payments: `money`; anything kacha also needs `kacha`
   - cash count: `money` + `today`
   - audit history: `settings` (owner)
   - the weigher (no `money`) sees no amounts at all; the backend gives them a money-free weighing list
4. **Order stages:** estimate → accepted → weighed → done. No skipping or going back. Items can
   only be edited as an estimate; weights only while waiting to be weighed; "weighed" needs every
   item's weight; a finished order can never change. Only estimates can be deleted.
5. **Money records are permanent.** Payments, cash counts, rate history, weigh batches and the audit
   history can't be edited or deleted. A mistake gets a **reversal** (exact opposite amount, linked
   to the original, only once).
6. **Bills can always be reproduced.** Each item stores the rate, cutting rate and density used; each
   order stores the rules used and, when finished, its final amounts (which must add up; no GST on kacha).
7. **Automatic audit history** of every change, with who did it and before/after values.

## Tables
| Area | Table | What it holds |
|---|---|---|
| Company | `companies` | Each business on the platform (SRS Trading first) |
| | `company_settings` | GST %, no-bill %, smallest inch, slip numbering, densities, slip header |
| | `people` | Staff: name, role, permissions, language. *Who* someone is |
| | `private.auth_credentials` | *How* they log in: PIN today; phone/email/passkey/MFA later. Never exposed |
| | `private.session_unlocks` | Which phone/tablet logins are unlocked with a PIN right now (see `docs/LOGIN.md`) |
| Catalog | `materials` | Grades (EN8, SS304…), family, density override, info notes |
| | `material_rates` | Rate **history** (₹/kg and cutting ₹/sq in/cut) with the time each took effect |
| | `current_material_rates` (view) | Latest rate that has started |
| Customers | `customers` | Name, phone, notes |
| | `customer_rates` | Special-rate **history** per customer and grade (empty = removed) |
| | `current_customer_rates` (view) | Current special rates |
| Orders | `orders` | The slip: numbers, customer, stage, rules used, final bill amounts, khata flag |
| | `order_items` | Grade, shape, sizes as typed, mm/inch, **copies of rates and density used**, actual weight |
| | `order_item_lengths` | Each cut length with pieces and cuts (several per item) |
| | `weigh_batches` | One scale reading shared by items weighed together |
| Money | `payments` | Advances, pickup payments, khata payments, reversals. Permanent |
| | `cash_closes` | Daily cash count by the **shop's** date. Saving again adds a newer row |
| Platform | `audit_log` | Who changed what, when, before/after. Permanent |
| | `private.slip_counters` | Next internal and slip numbers (handed out one at a time) |
| | `private.idempotency_keys` | Stops a retried save from happening twice |
| | `private.jobs` | Background work queue (PDFs, WhatsApp, exports…). Worker comes later |

**Prototype → database names:** payment kind `pay` → `pickup`, `due` → `khata`. An order payment's
pakka/kacha side comes from its order's bill; only khata payments store a side.

## Commands
```
npm run db:status         # which migrations are applied / pending (changes nothing)
npm run db:migrate        # apply pending migrations, each all-or-nothing, recorded in history
npm run db:test           # database tests; every test is rolled back, leaves no data
npm run db:replay-check   # rebuild everything from the migrations inside a cancelled transaction
npm run auth:e2e          # real login flow over the internet with dev test numbers
npm run functions:deploy  # deploy backend functions (supabase/functions)
```
Migrations are **append-only**: to change something, add a new file. `db:migrate` stops if an
applied file was edited.

## Tests (`supabase/tests/`)
- `01_tenancy` — companies and staff are isolated; no direct writes; bad values refused
- `02_who_sees_what` — 6 test users × every table: exact row counts (60 checks)
- `03_cannot_break_it` — ~45 things that must be refused (stages, finished bills, payments, rates, cross-company links) and the allowed paths
- `05_login_and_pin` — login, PIN rules, lockouts, staff management (see `docs/LOGIN.md`)
- `04_structure_guards` — whole-database checks that catch any future table missing RLS, `company_id`, safe links, indexes, write protection or edit protection
