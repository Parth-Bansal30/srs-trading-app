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
