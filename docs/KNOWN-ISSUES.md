# Known issues found in the prototype (Version 6)

Found while moving the calculations into `packages/core` (Milestone 1). The core module
**keeps the prototype's behaviour exactly** for now, so every number matches what was
approved. Each item below is fixed on purpose, in the milestone shown, with a test that
proves the fix — never silently.

| # | What happens | Why it matters | Fix | When | Needs owner OK? |
|---|---|---|---|---|---|
| 1 | **Cash count saved under the wrong date after midnight.** Between 12:00 am and 5:30 am IST, "Save today's count" files it under *yesterday's* date (it uses UTC date, while everything else on Today's Summary uses Indian date). Checked: at 2:00 am IST on 23 Sep it saves as 22 Sep. | Late-night count overwrites the previous day's count; the new day shows no count. | Backend saves cash count by the shop's date (Asia/Kolkata). | Milestone 4 | No — plain bug |
| 2 | **Weigh-together split can be 0.01 kg off the scale reading.** Each item's share is rounded separately. Example: 3 equal pieces weighed together at 10 kg → 3.33 + 3.33 + 3.33 = 9.99 kg. | Up to a few paise of material value lost per batch; the recorded weights don't add up to what the scale showed. | Give the leftover 0.01 kg to the largest piece so the parts always add up exactly to the scale reading. | Milestone 4 | **Yes** — changes recorded weights slightly |
| 3 | **Slip numbers and "today" come from each phone's own clock.** A phone with the wrong date or time zone would give wrong daily/monthly numbers and put sales on the wrong day. | Wrong or duplicate slip numbers across phones. | Done in core: dates are read in the shop's time zone (Asia/Kolkata), whatever the device or server clock says. The backend will hand out numbers centrally (one at a time, no duplicates). | Core ✅ / backend Milestone 4 | No |
| 4 | **Money is kept as ordinary decimal numbers in the browser**, rounded to paise at each step. | Fine for showing amounts; not ideal for permanent records. | The database stores money as exact decimals (`numeric(12,2)`); totals are rechecked on the server. | Milestone 2 / 4 | No |
| 5 | **"Stays in khata" compares paid vs bill by exact equality** after rounding. | Works while both sides are rounded the same way; fragile if they ever aren't. | Server compares in exact decimals. | Milestone 4 | No |
