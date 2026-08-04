# 05 — Balance alerts and core queries

**What to build:** Give the couple a clear view of their shared fund through exact LINE commands and timely low-balance alerts that work only after the month is active.

**Blocked by:** 04 — Monthly contribution lifecycle.

**Status:** ready-for-agent

- [ ] `餘額` shows the current provisional or formal balance and both spouses' contribution states.
- [ ] `最近紀錄` shows the latest ten visible transactions without entering a mutation workflow.
- [ ] `本月明細` shows the current month's active transactions and category subtotals.
- [ ] Exact commands are handled locally and consume no Gemini call.
- [ ] The balance may become negative and expenses are never rejected solely for insufficient funds.
- [ ] In an active month, downward crossings below NT$1,000, NT$500, and NT$0 each become alert-eligible.
- [ ] One operation that crosses multiple thresholds emits one alert for the lowest resulting band rather than multiple messages.
- [ ] A negative-balance alert shows the minimum amount required to return to zero without allocating responsibility between spouses.
- [ ] Raising the balance above a threshold rearms only that threshold for a later downward crossing.
- [ ] Awaiting-contribution months show provisional balance but emit no low-balance warning.

