# Login (Milestone 3)

## How it works for the people using it
1. **A business registers itself** (front door, 28 Sept 2026): Welcome → mobile number → SMS code → shop details
   (GST number checked offline), trade, team, free trial → owner's 6-digit PIN. One call, `register_company`,
   creates the company, settings, owner, team (by number), the trade's starting grades and rates, and unlocks the phone.
   **The owner adds staff** by name, mobile number and role (Owner, Sales, Weighing, Accounts, or custom
   permissions) — during registration or later on the People screen. Staff open the invite link, prove their number
   with a code (`join_by_phone` links them), see what their role can do, and set a PIN.
   A number that is in no shop can prove itself with a code but sees nothing; the app offers "send my number to the
   owner" or "start my own business".
2. **First time on a phone or tablet:** enter the mobile number → a 6-digit SMS code arrives (valid 5 minutes,
   one code per minute) → set a PIN. Staff: 4–6 digits. Owners/managers: 6 digits.
3. **Every day:** open the app → enter the PIN. No SMS needed. (Fingerprint / Face ID can come in the phone app.)
4. **Shared shop tablet:** each worker sets it up once with their own number; after that they pick their name
   and enter their own PIN.

## Safety
| Protection | How |
|---|---|
| Only staff see anything | Sign-up is ON (so a new business can register), but every read needs an unlocked staff session — a number in no shop sees nothing and cannot set a PIN |
| PIN is checked by the server | Until a phone's login is unlocked with the PIN, the database returns nothing at all — enforced in the database, not the app |
| Stolen phone / copied login | Useless without the PIN; the owner can also sign that person out everywhere |
| Guessing | 5 wrong PINs → locked 15 min; 10 → blocked until a fresh SMS code |
| Weak PINs refused | All-same (1111), in a row (1234, 4321), common ones (2580, 1212…), end of own mobile number |
| PIN never readable | Stored scrambled with bcrypt; never copied into history or logs |
| Changing a PIN | Needs an SMS code from the last 10 minutes (a refreshed login keeps the original code time) |
| Unlock doesn't last forever | Ends after 12 hours (setting `unlock_hours`), on sign-out, or if the person is deactivated — and on the phone sooner: "Lock the app after…" (default instantly, see below) |
| Staff management | Only people with the `people` permission, only in their own company, can't give permissions they don't have, can't deactivate themselves, and the company always keeps at least one manager |
| History | Every unlock, lock, PIN change, failed try (without the PIN) and staff change is in the audit log with who did it |

## Technical pieces
- **Supabase Auth (phone):** sign-up enabled (`npm run auth:config` shows/applies the dev settings); SMS code 6 digits, 5-minute expiry, 60 s between codes.
  Before real SMS in production: add a bot check (e.g. Cloudflare Turnstile) and per-number limits so strangers can't run up SMS costs.
  Built-in rate limits: 30 SMS/hour and 30 verifications/hour for the project.
- **Migration `20260926090000_logins_and_pins.sql`:** `private.session_unlocks`, the PIN functions
  `login_status`, `set_pin`, `unlock`, `lock_session` (callable by signed-in users), staff-management
  functions `admin_*` (backend only), and `app.current_person_id()` now requires an unlocked, live session.
- **Migration `20260928090000_self_signup.sql`:** trial/plan/trade/city/state on companies, `estimates_enabled` setting,
  `register_company`, `join_by_phone`, `login_status` also tells the trial and bill settings, `app.trade_template('steel')`.
- **Shared phone:** the app keeps each person's own login session on the device ("Who is using?"); switching locks the
  previous person and asks only the next person's PIN — no new SMS code.
- **Edge Function `staff-admin`** (`supabase/functions/staff-admin`): add_person, update_person, set_active,
  reset_pin, sign_out_everywhere. Checks the caller (signed in + unlocked + `people`), creates the Supabase
  login for new numbers, then calls the `admin_*` functions, which check everything again.
- **Mobile numbers** are stored as `+91XXXXXXXXXX`; typed with or without +91, 0 or spaces.

## Development test numbers (dev project only — never real SMS, code `123456`)
`+91 90000 00001`–`00005` (the practice SRS Trading (Dev) company: Papa, Parth, Ramesh, Suresh, Anil), `00009` (Claude's UI tester), `00010`–`00019` (free for trying "Start my business" and invites; Claude's UI test uses 17–19), `+91 90000 00901`–`00903` (automated login test) and `00904`–`00906` (automated business test).
They expire on 31 March 2027. **They must never be added to the production project.**

## Tests
- `npm run db:test` → `05_login_and_pin.sql`: ~45 checks (weak PINs, lockouts, blocking, expiry, sign-out,
  deactivation, staff-management limits, history, PIN never stored readable).
- `npm run auth:e2e`: the real flow over the internet — stranger refused, SMS code → PIN, owner adds a
  worker by number, worker sees no money and can't write, lock/unlock/wrong PIN, refresh, deactivate, sign out (30 checks).

## Before real SMS can be sent (owner's to-do)
1. DLT registration in SRS Trading's name (PE / entity ID).
2. Sender ID (header), 6 letters, e.g. `SRSTRD`.
3. OTP message template registered **exactly** as the app sends it:
   `Your SRS Trading login code is {#var#}. Valid for 5 minutes. Do not share it with anyone.`
4. An SMS provider account (recommended: MSG91), with its key entered into Supabase secrets by the owner.
Then: a `send-sms` hook function connects Supabase Auth to the provider (built once the account exists, so it
can be tested with real messages).

## Fingerprint / Face ID unlock (23 Oct 2026)
- The app names it by the device: **Face ID** on iPhones with the tall screen (X and newer), **Touch ID** on iPhone 8 / SE and
  Macs, "Face ID / Touch ID" on iPads, **Windows Hello** on Windows, **fingerprint** elsewhere (`lib/passkey.js` bioKind; the
  face icon on Face ID devices). It is the same passkey everywhere — the phone decides how the person proves it is them.
- Apple only shows Face ID / Touch ID after a tap, so on Apple devices the lock screen waits for "Unlock with Face ID"
  instead of asking by itself, and the server's challenge is fetched when the screen opens (also when the "switch on" offer
  opens) — the tap then goes straight to Face ID (a network wait between the tap and the request makes Safari refuse it).
  Android / Windows still ask by themselves.
- After the PIN, the app offers once per person per phone: "Unlock with your fingerprint next time?" (More → Fingerprint unlock switches it on or off).
  On a phone others use too, the offer warns that anyone whose finger opens that phone could open the account.
- It is a passkey (WebAuthn, platform authenticator, user verification required). The private key never leaves the phone; the
  server keeps the public key (`private.passkeys`). Switching on needs a PIN unlock in the last 10 minutes on that login session.
- Unlock: a fresh one-time challenge from the server (3 minutes, bound to the login session), signed by the phone, checked by
  the api with the saved public key → the same `session_unlocks` row as the PIN (`method = passkey`). A signature counter that
  goes backwards (a copied key) switches that key off. A PIN blocked after 10 wrong tries still needs a new SMS code.
- If the finger fails or is cancelled, the PIN pad is right there. Up to 5 phones per person; the owner can remove one
  (People → person → Fingerprint phones); "sign out everywhere" removes all.

- **The phone already has the key but the app forgot it** (25 Oct 2026 — found on Parth's iPhone): logging out, "Forgot PIN",
  or opening the app from Safari instead of the Home Screen icon (iOS keeps their storage apart) loses the app's note of the key,
  while the phone's keychain and the server still have it. Switching on then made the phone refuse a second key
  (`InvalidStateError`, the server lists the old key in `excludeCredentials`) and the switch stayed off. Now the switch / the
  offer shows **"This phone already has your Face ID key · Use it with Face ID"** (`NotAllowedError` with existing keys: "Switched
  it on before on this phone?"): one Face ID check with the server (`passkeyUnlock`, which now also returns the key's public half
  `{ credential_id, jwk, alg }`) and the phone keeps the same key again (`reconnectPasskey` / `reconnectFinger`). The unlock
  challenge is fetched as soon as the save fails, so the iPhone tap goes straight to Face ID. Browser test t9 (21 checks).

## Without internet (23 Oct 2026)
- A person who was fully logged in on this phone before can open the app offline. The PIN is then checked on the phone
  against a scrambled copy (PBKDF2-SHA256, 150,000 rounds, random salt) kept after the server last accepted it; 5 wrong
  tries → 15 minutes wait on that phone. The finger is checked on the phone with the kept public key.
- Nothing reaches the server until the internet is back: the waiting entries are then sent with their request keys (never
  twice). If the server wants the PIN again first, the app says "Unlock to send". A PIN unlock lasts a working day (12 h) on
  the phone too.

## Lock the app after… (24 Oct 2026)
- Each person chooses on each phone (More → **Lock the app**): **Instantly** (the default), 5 min, 30 min, 1 hour or 12 hours.
  Kept with the person on that phone (`device_people[].lockAfter`, `lib/autolock.js`). The server's `unlock_hours` still applies
  on top — the phone can only lock sooner.
- "Away" = the app is off the screen (`visibilitychange` / `pagehide`; `lastSeen` is kept per person). Coming back from the
  background after the chosen time → **automatic lock**: the server session is locked too (`lock_session`), and the screen the
  person was on stays open underneath, so a half-filled form is still there after Face ID / fingerprint / PIN
  (`auth.autoLocked`; only for the same person — "Not you?" starts fresh). While away on "Instantly", a plain cover hides the
  app (the recent-apps picture shows nothing).
- Opening the app fresh (closed from recent apps) after the chosen time also asks; on "Instantly" it always asks. A flicker
  shorter than 3 s when coming back from the background is ignored.
- Leaving **on purpose** from inside the app never locks if the person is back within 5 minutes: bill photo / file picker,
  WhatsApp and other links, phone calls, print, the share sheet, an app update. It only counts if the app leaves the screen within
  15 s of that tap; the share sheet and Face ID sheet end it as soon as they close. Unlocking or locking forgets it.
- `device.js` now always builds on the newest stored list of people and follows changes from other tabs (a second tab
  could otherwise undo a change such as switching Face ID on).
- Tests: `apps/web/test/autolock.test.mjs` (rules) and the browser test t8 (29 checks incl. iPhone Face ID after an auto lock).
