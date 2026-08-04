# 04 — Monthly contribution lifecycle

**What to build:** Let both spouses independently declare each month's contribution, including a zero contribution, while preserving early expenses as provisional until both people have completed their monthly contribution state.

**Blocked by:** 02 — Natural-language expense ledger.

**Status:** ready-for-agent

- [ ] A spouse's first clear monthly-contribution message creates the contribution and marks that spouse complete for the fund month.
- [ ] `本月不存` or an equivalent unambiguous statement marks the spouse complete without creating a zero-dollar ledger entry.
- [ ] The month starts from NT$0 and remains `awaiting_contributions` until both spouses have confirmed a positive or zero contribution.
- [ ] Expenses and top-ups can post before activation, but every balance response is explicitly provisional.
- [ ] When both spouses complete their contribution state, the month becomes active and exposes a formal available balance.
- [ ] A repeated monthly-contribution message is held for a choice between correcting the original contribution and recording an additional top-up.
- [ ] A top-up increases the current balance but never satisfies a monthly contribution unless explicitly entered as that contribution.
- [ ] Deleting the only contribution confirmation for an open month returns it to awaiting state while keeping expenses intact.
- [ ] Contribution actor is retained for audit but does not create spouse-to-spouse debt or spending comparison.

