# Login (Milestone 3)

## How it works for the people using it
1. **The owner adds staff** by name, mobile number and role (Owner, Sales, Weighing, Accounts, or custom
   permissions). Nobody can sign themselves up, and a number the owner hasn't added can't even ask for a code.
2. **First time on a phone or tablet:** enter the mobile number → a 6-digit SMS code arrives (valid 5 minutes,
   one code per minute) → set a PIN. Staff: 4–6 digits. Owners/managers: 6 digits.
3. **Every day:** open the app → enter the PIN. No SMS needed. (Fingerprint / Face ID can come in the phone app.)
4. **Shared shop tablet:** each worker sets it up once with their own number; after that they pick their name
   and enter their own PIN.

## Safety
| Protection | How |
|---|---|
| Only added staff can log in | Public sign-up is off in Supabase Auth; no code is sent to unknown numbers |
| PIN is checked by the server | Until a phone's login is unlocked with the PIN, the database returns nothing at all — enforced in the database, not the app |
| Stolen phone / copied login | Useless without the PIN; the owner can also sign that person out everywhere |
| Guessing | 5 wrong PINs → locked 15 min; 10 → blocked until a fresh SMS code |
| Weak PINs refused | All-same (1111), in a row (1234, 4321), common ones (2580, 1212…), end of own mobile number |
| PIN never readable | Stored scrambled with bcrypt; never copied into history or logs |
| Changing a PIN | Needs an SMS code from the last 10 minutes (a refreshed login keeps the original code time) |
| Unlock doesn't last forever | Ends after 12 hours (setting `unlock_hours`), on sign-out, or if the person is deactivated |
| Staff management | Only people with the `people` permission, only in their own company, can't give permissions they don't have, can't deactivate themselves, and the company always keeps at least one manager |
| History | Every unlock, lock, PIN change, failed try (without the PIN) and staff change is in the audit log with who did it |

## Technical pieces
- **Supabase Auth (phone):** sign-up disabled; SMS code 6 digits, 5-minute expiry, 60 s between codes.
  Built-in rate limits: 30 SMS/hour and 30 verifications/hour for the project.
- **Migration `20260926090000_logins_and_pins.sql`:** `private.session_unlocks`, the PIN functions
  `login_status`, `set_pin`, `unlock`, `lock_session` (callable by signed-in users), staff-management
  functions `admin_*` (backend only), and `app.current_person_id()` now requires an unlocked, live session.
- **Edge Function `staff-admin`** (`supabase/functions/staff-admin`): add_person, update_person, set_active,
  reset_pin, sign_out_everywhere. Checks the caller (signed in + unlocked + `people`), creates the Supabase
  login for new numbers, then calls the `admin_*` functions, which check everything again.
- **Mobile numbers** are stored as `+91XXXXXXXXXX`; typed with or without +91, 0 or spaces.

## Development test numbers (dev project only — never real SMS, code `123456`)
`+91 90000 00001`–`00005` (the practice SRS Trading (Dev) company: Papa, Parth, Ramesh, Suresh, Anil), `+91 90000 00901`–`00903` (automated login test) and `00904`–`00906` (automated business test).
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
