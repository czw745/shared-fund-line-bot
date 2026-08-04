# 07 — Monthly reminders, close, and carryover

**What to build:** Automate the monthly rhythm by reminding missing contributors, closing each fund month idempotently, carrying the actual balance forward, and reporting the result without blocking on an incomplete contribution.

**Blocked by:** 04 — Monthly contribution lifecycle; 05 — Balance alerts and core queries.

**Status:** ready-for-agent

- [ ] At 09:00 Asia/Taipei on the first day, one group reminder reports both spouses' contribution states.
- [ ] At 09:00 on the third day, a reminder is sent only when someone remains incomplete and identifies only the missing spouse or spouses.
- [ ] No later automatic contribution reminders occur that month.
- [ ] At 00:10 on the first day, the prior month closes after already received group events are drained.
- [ ] Close records actual contributions, top-ups and other income, refunds, expenses, largest expense category, closing balance, and contribution completion state.
- [ ] A month closes and carries its actual balance forward even when one spouse remains incomplete, with an explicit incomplete marker.
- [ ] Re-running any reminder or close job cannot duplicate notifications, close records, or carryovers.
- [ ] The closing report presents all agreed values and CSV status without automatically generating analysis charts.
- [ ] The close and carryover remain rebuildable from ledger history rather than becoming an independent balance truth.

