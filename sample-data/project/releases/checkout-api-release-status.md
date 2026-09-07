# Checkout API — release status, week 31

**Release:** 26.2 · **Gate:** code freeze · **Owner:** dana

## Where we are

The freeze was due at the end of week 30 and did not happen. Two items are
open, both carried from the last release, and neither is on a path that closes
them without a decision.

| Item | Owner | Opened | State | Blocks freeze |
|---|---|---|---|---|
| CR-2214 — nw-auth-sdk token refresh race | ravi | wk 24 | Awaiting upstream fix | Yes |
| CR-2251 — ledger write path under retry storms | mei | wk 27 | In validation | Yes |
| CR-2263 — form validation on the payout screen | dana | wk 29 | Closed wk 31 | No |
| CR-2270 — chart-kit upgrade for release 24.3 | ravi | wk 30 | In validation | No |

## Schedule against dependencies

The 26.2 release train (week 36) needs `nw-auth-sdk` at 4.3. The maintainer's
current turnaround puts a tagged release at week 35, which leaves no float. If
the tag slips past week 33, the train moves and the freeze moves with it.

## Risks

1. **Sole-maintained SDK.** One maintainer, no fork, on the critical path. See
   `vendors/scorecard.csv`.
2. **Ledger validation depends on a load rig** shared with the settlement team.
   Rig time is booked to week 34.

## Asks for the steering call

- Approve forking `nw-auth-sdk` if the upstream tag slips past week 33.
- Confirm whether the freeze can close with CR-2251 in validation rather than
  merged.
