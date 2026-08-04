# 10 — Spending analysis charts

**What to build:** Let the couple request three consistent, mobile-readable spending analyses whose values come from the ledger and whose temporary public image routes reveal no financial data in their URLs.

**Blocked by:** 05 — Balance alerts and core queries; 07 — Monthly reminders, close, and carryover.

**Status:** ready-for-agent

- [ ] `本月分析` returns a horizontal major-category bar chart and the top three small categories.
- [ ] `每月趨勢` returns six months of contribution and expense bars with a closing-balance line.
- [ ] `分類趨勢` returns six months of major-category net spending as stacked bars.
- [ ] All totals and summaries are calculated deterministically from D1 ledger data; Gemini neither calculates totals nor renders charts.
- [ ] Fixed dimensions, typography, colors, ordering, labels, currency formatting, and empty states make repeated charts comparable on mobile.
- [ ] Two or three deterministic text statements accompany each chart and match the same statistics payload.
- [ ] QuickChart receives only anonymous aggregated labels and values, with no user, group, message, note, transaction, or Drive identifiers.
- [ ] Public chart URLs contain opaque signed tokens rather than raw statistics and expire after seven days.
- [ ] Invalid or expired chart routes return 404; valid routes proxy a PNG suitable for LINE.
- [ ] QuickChart failure returns the text analysis with an explicit unavailable-chart state and never invokes a paid renderer.

