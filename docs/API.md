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
| `reversePayment` | money + khata + **delete** (owner, 25 Oct 2026) | cancel a payment with the exact opposite entry (reason required, once only). A finished slip it was paid on moves into the khata. `khata` marks the payment `cancelled: {reason, by, at}` and its opposite entry `reversal: true` (left out on screen) |
| `saveCashCount` | money + today | filed under the **shop's date**; expected cash worked out by the database |
| `changeMaterialRate` · `createMaterial` · `updateMaterial` · `setCustomerRate` | rates | rate history is kept for ever; `rate: null` removes a special rate |
| `createCustomer` · `updateCustomer` | new | |
| `changeSettings` | settings | GST %, kacha %, min inch, slip numbering, weight warning %, **starting slip number** (only before the first order), AI daily limit, company name/GSTIN/phone/address |
| `cancelOrder` | new | cancel an accepted/weighed order with a reason — only once its advance is settled (estimates are simply deleted) |
| `adjustAdvance` | money (+kacha); refund also **delete** (owner) | `{order_id, action, amount, …}`: **refund** (give money back by Cash/UPI/Bank/Cheque, reason required — also the extra paid on a finished order), **move** (to `target_order_id`, same customer, open order), **credit** (keep for the customer on `side`). Moves and credit are marked `Adjust`, so they never touch the cash count |
| `refundCredit` | money + khata + **delete** (owner) | give back credit a customer holds in the khata (available amount worked out by `@srs/core`) |
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
| `stockData` (read) | orders | every stock item grouped by grade + shape: kg on hand, **booked** (expected weight on open orders that take from it), free, first bought, supplier, HSN. Buying rate, cost and stock value only with **stock** |
| `stockItem` (read) | orders | one stock item with every move (bought, sold, undone, counted) and the bill / slip it came from. Rates only with stock |
| `purchaseContext` (read) | stock | grades, existing stock items (to show "adds to your stock"), suppliers, names remembered from earlier bills, whether automatic reading is on (`can_read`), and `history` for the smart bill checks (last 8 bill rates per grade, bills of the last 120 days; no-bill purchases only for people allowed to see them) |
| `readPurchaseBill` | stock | `{file_key}` of a PDF/photo already uploaded to the private `bills` bucket → the lines read by Claude (`ANTHROPIC_API_KEY`), or `{ai:false}` so the person types them. Nothing is saved |
| `savePurchase` | stock | supplier, bill no./date, GST bill or not, lines `{description, hsn, qty, qty_unit, rate, rate_unit, amount, material_id, shape, label}`, freight, other, GST, round-off, total, paid. **A stock item = grade + shape + HSN + rate per kg**: a line whose four match an item adds to it, anything else makes a new item. Lines + charges + GST must equal the total (±₹1) unless `accept_diff`. Freight/other is shared by weight into each item's cost. Same supplier + bill no. twice → `409 duplicate`. `kind: 'opening'` = stock already in the godown (no bill) |
| `purchases` (read) / `purchase` (read) | stock | bills, newest first; one bill with lines, its stock items and a 10-minute link to the bill file; `can_cancel` |
| `purchasePaid` / `purchaseCancel` | stock | mark a bill paid; cancel a bill (reason) — its kg come off again, refused when less is left than the bill brought in (some already sold or counted down) — correct the count instead |
| `stockCount` | stock | `{id, count, close?, note}`: the real kg after counting (the difference is saved as a correction), or close a finished item (rest written off) |
| `setLowStock` | stock | warn in the evening summary when a grade is below `kg` (`null` = off) |
| `setItemStock` | orders | change which stock an order item takes from — only while the order is an estimate or accepted, and only stock of the same grade |

| `accounts` (read) | money | where money can go: Shop cash (the drawer, always there) + the shop's own bank / UPI / Paytm / wallet accounts it may choose (owners-only accounts only for people with **settings**). `all: true` (settings): the Settings list with hidden ones and account numbers |
| `saveAccount` | settings | `{account: {id?, name, kind (bank·upi·paytm·wallet·other), owner (firm·personal), number?, staff_can, hidden}}`. The drawer can be renamed, never hidden or changed. Names unique per shop |
| `orderAccounts` / `checkAccount` | settings | new order of the list (`ids`); tick an account as checked for a shop day (`account_id`, `day`, `checked`) |
| **Where money went** (all money ops) | | `createOrder`/`acceptOrder` advance, `addAdvance`, `finalizeOrder`, `recordPayment` take `parts: [{account_id, amount, method?}]` (a split — must add up exactly, else `400 split_differs`) or `account_id` (+ `method`: UPI·IMPS·NEFT·RTGS·Cheque) for all of it; refunds (`adjustAdvance` refund, `refundCredit`, `deleteSlips` refund) take one `account_id`. Without them the old `mode` still works (Cash → drawer, others "not placed"). These go through `api_pay`, which runs the operation and places the payment in one transaction (`payment_parts`, never edited; a correction mirrors its parts). The payment's mode follows its parts, e.g. `Cash+Bank`. The cash count only expects the cash parts. `daySummary` has `summary.accounts` (tally per account, firm / personal, not placed, ticks) and `account_parts` for owners |

| **Money out (23 Oct 2026)** | | |
| `saveExpense` | expenses (shop expense) · stock (paid a supplier) · settings (owner's own) | `{kind: expense·supplier·owner, category (tea, labour, freight, blade, fuel, salary, repair, electricity, rent, phone, office, bank, tax, puja, other), amount, account_id, method?, day? (owners up to 400 days back, others 3), paid_to?, note?, gst_bill?, gst_amount?, bill_no?, seller_gstin?, supplier_id + purchase_ids (marks his bills paid), file_key? (receipt photo), replaces_id? (change = old one cancelled in the same step), offline_at?}`. Never edited, only cancelled or replaced |
| `cancelExpense` | expenses / stock / settings | `{id, reason}`; others' or older entries: owners only. Bills it paid go back to "to pay" |
| `expenses` (read) | expenses / stock / settings | `{from, to}` (≤ 400 days): entries (each person sees the kinds they may), money moved, suppliers with unpaid bills, `totals` by core `expenseTotals` (by kind, category, account; GST for the CA; from the drawer) |
| `uploadReceipt` / `expenseFile` | expenses / stock / settings | a receipt photo into the private `bills` bucket → `file_key`; a 10-minute link to it |
| `saveTransfer` / `cancelTransfer` | expenses / settings | money moved between two of the shop's own accounts `{from_account, to_account, amount, reason: move·deposit·withdraw·home, method?, note?, day?, offline_at?}` — never a sale, never an expense |
| `cashBook` (read) | money + today | the drawer as a cash book for a day: opening (left last night), cash in, cash out, should be there, the counts, every cash move, and where cash can be taken (`safes`: cash at home, banks) |
| `saveCashCount` | money + today | now `{counted, take?, take_to?, note?, offline_at?}`: the count is a **balance point** for the drawer; `take` is moved out at once (`reason: close`, to `take_to` or "Cash at home", made the first time); the rest is tomorrow's opening. Before the drawer's first count every day starts at zero (the old way) |
| `accountBalances` (read) / `accountBook` (read) / `setBalance` | settings + money | every account with what should be in it now (last balance point + every move after it); one account's moves between two days with the running balance; "the passbook / app shows ₹…" → a new balance point (the first one = starting balance) |
| **Supplier GST number (23 Oct 2026)** | | |
| `suppliers` (read) | stock | suppliers with GST status (active / cancelled / suspended / inactive / not found, since when, by service or portal), bills in 6 months, GST on them, still to pay; `service` = automatic check on |
| `gstCheck` | stock | `{gstin, refresh?}`: a check from the last 7 days is used again; else the GST data service (`GST_API_PROVIDER` = sandbox · cashfree · custom, `GST_API_KEY`, `GST_API_SECRET`, `GST_API_URL`, `GST_API_METHOD`, `GST_API_HEADERS`) — answer read by core `readGstAnswer`. Without a key: `{service:false}` |
| `gstMark` | stock | "I checked on the GST portal": `{gstin, status, cancel_date?, legal_name?, note?}` |
| Evening job | | also re-checks (service only) suppliers with bills in the last 6 months every 30 days; `daySummary` lists suppliers dealt with lately whose number is no longer active (`supplier_gst`) |
| **Without internet (23 Oct 2026)** | | `createCustomer` (`id`), `createOrder` (`order_id`, `items[].id`), `acceptOrder`, `addAdvance`, `recordWeights`, `finalizeOrder`, `recordPayment`, `saveExpense`, `saveTransfer`, `saveCashCount` accept `offline_at` (when it really happened, ≤ 3 days back) and run through `api_run`, which sets that time for the operation (orders, payments). The phone chooses the slip's / customer's id so the slip can be weighed and finished offline; the slip **number** is still given by the database when it arrives, for the day it was made |
| **Fingerprint unlock (23 Oct 2026)** | before the PIN | `passkeyBegin {purpose: register·unlock}` → a one-time challenge (3 min); `passkeyRegister {challenge, clientDataJSON, attestationObject, label}` needs a **PIN** unlock in the last 10 minutes; `passkeyUnlock {challenge, credential_id, clientDataJSON, authenticatorData, signature}` → the same unlock as the PIN. Checked with core `verifyRegistration` / `verifyAssertion` (WebCrypto, ES256 / RS256); allowed origins `PASSKEY_ORIGINS` (add the real domain there). `passkeys` (read) / `passkeyRemove`: my fingerprint phones (people managers: anyone's). "Sign out everywhere" removes them too |

**Stock rule:** stock comes off when a slip is **weighed** (the real weight), and goes back if a weighed slip is cancelled or a weighed/finished slip is deleted. Every move is a new row in `stock_moves` — nothing is edited. New orders pick the stock for each item with core `stockChoices`: same grade, same shape (or no shape), the oldest that still has enough free kg; if none has enough, the one with the most (flagged). Selling with no stock is allowed and flagged in the evening summary.

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
The same key also switches on **reading purchase bills** (PDF or photo). Optional: `ANTHROPIC_BILL_MODEL`
(default `claude-sonnet-4-5`). Without it, the bill file is still kept and the lines are typed in.

## Files
- `supabase/migrations/20260926120000_domain_operations.sql` — the `api_*` database functions (backend only).
- `supabase/functions/api/index.ts` — login check, request key, routing. `ops.js` — the operations (plain JS, no imports, so it runs in Deno and in Node tests).
- `scripts/sync-core.mjs` — copies `packages/core/src` into `supabase/functions/_shared/core` before every deploy (not kept in git, so it can't drift).

## Tests
```
npm run test:api          # unit tests of the operations (no network)
npm run test:web          # what the app shows for entries made without internet
npm run money:e2e         # 32 checks over the internet: expenses, money moved, cash book, offline entries, GST check, fingerprint
npm run db:test           # 06_domain_operations.sql: ~90 checks in the database itself
npm run db:parity-check   # database slip numbers = @srs/core for 2,000 moments, 6 time zones
npm run domain:e2e        # 94 checks over the internet with real logins (dev numbers 904–906)
npm run seed:dev          # practice copy of SRS Trading from the prototype's own data (dev only)
```
