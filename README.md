# SRS Trading App

Production version of the SRS Steel Desk app for steel trading: orders with cut lengths,
weight from size, cutting charge, weighing, GST (pakka) and no-bill (kacha) billing,
advances, khata and daily summaries — in English, Hindi and Hinglish.

## What's here
| Folder | What it is |
|---|---|
| `prototype/v6/` | The approved Version 6 prototype, frozen. Open `final.html` in a browser to use it. Never edited. |
| `packages/core/` | The business rules (weight, cutting, GST/kacha, finishing, khata, slip numbers) as a standalone module, with tests. |
| `supabase/` | The database: migrations (the only way it changes) and database tests. |
| `scripts/` | Tools to apply migrations and run database tests. |
| `docs/` | Database guide, known issues and technical notes. |

## Proof the numbers match the prototype
`packages/core/test/parity.test.js` runs the real prototype code next to the new module and
compares them on the sample data plus thousands of generated orders (every shape, mm and inch,
fractions, bad input, all bill types, advances, part payments, khata scenarios, slip numbers
across years). `rules.test.js` checks the agreed business rules directly.

```
npm test          # Indian time: full comparison with the prototype
npm run test:utc  # UTC clock, as on a server
```

Tests run automatically on GitHub for every change (see the Actions tab).

## Status
- ✅ Milestone 1 — project on GitHub, prototype frozen, business rules extracted and proven identical
- ✅ Milestone 2 — database foundation: 18 tables, company separation, permissions, stage rules, permanent money records, rate history, audit history — all tested (see `docs/DATABASE.md`)
- ✅ Milestone 3 — logins: mobile number + SMS code, then a server-checked PIN; staff management (see `docs/LOGIN.md`)
- ⏳ Milestone 4 — backend domain operations (create order, weigh, finish, payments)
