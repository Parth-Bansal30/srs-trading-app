# Backend operations — the `api` function (Milestone 4)

## The idea in one line
**The app asks, the backend decides.** A phone never writes an order, weight, bill or payment
into the database itself. It sends a request to one door — the Edge Function `api` — which checks
who is asking, does the steel maths with `@srs/core` (the same rules as the approved prototype),
and saves everything in one all-or-nothing step.

```
phone ──► api (Edge Function) ──► public.api_* (database function) ──► tables
          │ signed in + PIN?        │ same person, same company,
          │ permission?             │ permission again, stage rules,
          │ @srs/core maths         │ request key, one transaction
```
Two layers check permissions, so a bug in one can't let anything through.

## Request and answer
```
POST https://<project>.supabase.co/functions/v1/api
Authorization: Bearer <the person's login token>
{ "v": 1, "op": "createOrder", "key": "<new uuid for this action>", "args": { … } }

→ 200 { "ok": true,  "v": 1, "data": { … } }
→ 4xx { "ok": false, "v": 1, "error": "<code>", "message": "<plain words to show>" }
```
- **`v`** — the version of this contract. An old app gets `426 update_app` instead of doing something wrong.
- **`key`** — a fresh id for every tap on Save. If the network drops and the phone sends it again,
  the **first answer comes back** (`"replayed": true`) and nothing happens twice. The same key with
  different details is refused (`409 duplicate`). Readers (`weighingList`, `askSteelQuestion`) need no key.

| Error | Meaning | App shows |
|---|---|---|
| 401 `not_signed_in` / `pin_required` | no login / phone locked | login or PIN screen |
| 403 `not_allowed` | no permission | message |
| 400 `invalid` / `need_part` / `choose_bill` | something missing or wrong | the message (plain words) |
| 409 `changed` | something changed while you were finishing (e.g. another phone added an advance) | "check and try again" |
| 409 `not_allowed_now` / `not_weighed` / `not_waiting` | wrong stage (already finished, already weighed…) | message, refresh |
| 409 `duplicate` | e.g. the same payment cancelled twice | message |
| 429 `daily_limit` | Ask Claude questions for today used up | message |
| 503 `ai_not_configured` | Ask Claude not switched on yet | message |

## Operations (`op`)
| op | Who (permission) | What it does |
|---|---|---|
| `createOrder` | new (+money for advance, +**price** for a typed rate) | `{customer_id, items, accept?, advance?}` → slip number, estimate. Rates: customer special rate, else current rate; only people with the **price** permission ("change rate on slip", owners by default) may type a different rate. Density: grade's own, else family. Rules (min inch, densities, time zone) are **snapshotted** on the order |
| `updateOrder` | new | edit an estimate (items replaced, same checks) |
| `acceptOrder` | new | estimate → accepted, optional advance |
| `addAdvance` | money | advance on an accepted/weighed order |
| `weighingList` | weigh | orders waiting to be weighed, with sizes, pieces and **expected weight — never rates or amounts** |
| `recordWeights` | weigh | `{order_id, weights:[{item_id, weight}], batches:[{total_weight, item_ids}], submit}`. Weigh-together split by `@srs/core` — **always adds up exactly** to the scale reading. Warns (never blocks) when a weight is more than the set % from the sizes |
| `finalizeOrder` | money (+kacha for kacha) | `{order_id, bill, pay_mode, paid?, pay_method, note?}` → totals by `@srs/core finishCalc`, GST/kacha % from settings, pickup payment, khata flag. If weights, advance or % changed meanwhile → `409 changed` |
| `recordPayment` | money + khata (+kacha) | khata payment `{customer_id, amount, mode, side, note}` |
| `reversePayment` | money + khata | cancel a payment with the exact opposite entry (reason required, once only). A finished slip it was paid on moves into the khata |
| `saveCashCount` | money + today | filed under the **shop's date**; expected cash worked out by the database |
| `changeMaterialRate` · `createMaterial` · `updateMaterial` · `setCustomerRate` | rates | rate history is kept for ever; `rate: null` removes a special rate |
| `createCustomer` · `updateCustomer` | new | |
| `changeSettings` | settings | GST %, kacha %, min inch, slip numbering, weight warning %, **starting slip number** (only before the first order), AI daily limit, company name/GSTIN/phone/address |
| `cancelOrder` | new | cancel an accepted/weighed order with a reason — only once its advance is settled (estimates are simply deleted) |
| `adjustAdvance` | money (+kacha) | `{order_id, action, amount, …}`: **refund** (give money back by Cash/UPI/Bank/Cheque, reason required — also the extra paid on a finished order), **move** (to `target_order_id`, same customer, open order), **credit** (keep for the customer on `side`). Moves and credit are marked `Adjust`, so they never touch the cash count |
| `refundCredit` | money + khata | give back credit a customer holds in the khata (available amount worked out by `@srs/core`) |
| `addOldDue` · `reverseOldDue` | money + khata (+kacha) | old balances from the paper khata: a lump sum (no `ref`) or one old slip (`ref` = old slip number), dated; corrected only by an exact opposite entry |
| `khata` | money | every customer's account worked out by `@srs/core` (due, credit, oldest due, per side); with `customer_id` also the full entries |
| `reminderList` | money + khata | customers to **ask** about: slips unpaid/part-paid for `reminder_after_days` (default 25), not reminded in the last `reminder_repeat_days` (default 7). Nothing is sent. Message preview is neutral (no bill type) |
| `sendReminder` | money + khata (+kacha) | the owner tapped Yes: the message is rebuilt on the server from real figures, logged in `reminders`, and returned with a WhatsApp link (`wa.me`) that opens the chat on the phone. WhatsApp Cloud API (same number via Meta "coexistence") comes later |
| `slipDoc` | money (+kacha for a no-bill slip) | the customer's copy of a finished slip, built on the server from the saved figures (no rates per kg, no notes, never the word kacha), saved in `shared_docs` behind a secret link `#/d/<token>` — one link per slip and language, refreshed on every call. `send: true` marks it sent on WhatsApp. `upi: false` leaves out the pay-by-UPI QR |
| `statementDoc` | money + khata | account statement for `from`–`to` (shop dates) and `which` bills (both / pakka / kacha): opening balance, every slip and payment with the running balance, closing — the khata's numbers. Slips paid in full at pickup are listed with “paid for slip #…”. `preview: true` only works it out (nothing saved); otherwise a new copy + link is saved each time |
| `daySummary` (read) | money | one shop day (`day` = YYYY-MM-DD, default today): sales GST / no bill, where the slips' money went, money in by mode, cash drawer, khata, "needs a look" (cash difference, rate below the usual, weight off, cancelled, money returned, overdue customers, orders waiting), top customers — worked out by core `daySummary`. No-bill figures and the cash count only with the kacha permission |
| `eveningGet` (read) / `eveningSet` | money / settings | evening summary settings: on, time, days (1 = Mon … 7 = Sun), who gets it (only people with money) + the public push key |
| `savePush` / `pushTest` | money | this phone's notifications on/off (`sub` = the browser's push subscription); send today's summary to my phones now |
| `deletePreview` (read) | delete | what deleting `order_ids` (1–50) would undo: status, total, money taken, in khata — nothing sent or changed |
| `deleteCode` | delete | checks the slips, then sends a one-time SMS code to the caller's OWN login number (same SMS as login, Supabase Auth). Returns only the last digits (`to`) |
| `deleteSlips` | delete (+kacha for a no-bill slip) | with `code` (6 digits), `reason` and `money`: `never` (payments reversed — test / typed twice), `credit` (kept as the customer's khata credit), `refund` + `mode` (given back), `none`. Any stage, old slips too. The slip is kept with status `deleted`, who / when / why / from which stage; it counts nowhere (sales, khata, statements), its number is never reused, its customer link says "cancelled by the shop". The code is checked on the server (throwaway login, signed out at once — the person's own login stays unlocked); a retry with the same request key returns the first answer even though the code is used up |
| `requestDelete` | orders or new | staff ask the owners to delete a slip (reason); owners with notifications switched on get a phone notification. One open request per slip |
| `deletedSlips` (read) / `declineDelete` | delete | deleted slips (newest first) and open requests (`order_id` = only that slip's); "not needed" closes a request |

**Evening job:** pg_cron calls the api every 10 minutes with header `x-cron-secret` (from Vault; set up by `npm run evening:setup`). The api sends each due shop's summary as a phone notification (Web Push, `webpush.js`, RFC 8291/8292) to everyone who gets it, once per day (`private.evening_log`). Phones that unsubscribed are removed.
| `askSteelQuestion` | any staff | the prototype's steel guide, through the backend so the AI key never sits in the app. Daily limit per company (default 100) |

Slip numbers are handed out by the database one at a time (20 phones at once → 20 different
numbers, tested). Daily/monthly/yearly numbers only have to be unique **within their period**
("22Sep-1" comes back next year — allowed); the internal number is unique for ever.

## Switching on Ask Claude (owner's to-do, when wanted)
1. Create an API key at console.anthropic.com (billing on the owner's account).
2. Supabase dashboard → Edge Functions → Secrets → add `ANTHROPIC_API_KEY` (typed there by the
   owner — never pasted in a chat). Optional: `ANTHROPIC_MODEL`.
Until then the app says "Ask Claude is not switched on yet".

## Files
- `supabase/migrations/20260926120000_domain_operations.sql` — the `api_*` database functions (backend only).
- `supabase/functions/api/index.ts` — login check, request key, routing. `ops.js` — the operations (plain JS, no imports, so it runs in Deno and in Node tests).
- `scripts/sync-core.mjs` — copies `packages/core/src` into `supabase/functions/_shared/core` before every deploy (not kept in git, so it can't drift).

## Tests
```
npm run test:api          # 11 unit tests of the operations (no network)
npm run db:test           # 06_domain_operations.sql: ~90 checks in the database itself
npm run db:parity-check   # database slip numbers = @srs/core for 2,000 moments, 6 time zones
npm run domain:e2e        # 44 checks over the internet with real logins (dev numbers 904–906)
npm run seed:dev          # practice copy of SRS Trading from the prototype's own data (dev only)
```
