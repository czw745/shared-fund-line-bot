# 夫妻共同基金 LINE 記帳系統 MVP 規格

## Problem Statement

夫妻共同使用一筆每月投入的共同基金，但缺少一個雙方都能自然使用、即時可信、無須另外開啟 App 的共同帳本。使用者希望直接在專用 LINE 群組輸入日常語句，系統便能辨識存入、支出與補登，立即更新共同基金餘額，並處理每月存入提醒、月底關帳、跨月結轉、歷史更正、分析圖表與 CSV 留存。

系統的核心不是計算夫妻彼此欠款，而是維持一份共同基金的單一可信帳本。付款人只用於稽核與交易管理；所有支出都視為兩人的共同消費。

MVP 必須在正常使用下維持零費用，且任何免費額度耗盡時只能停止受影響功能，不得自動切換付費資源。系統可以暫時不可用，但不能記錯帳、重複入帳、洩漏帳務資訊或產生費用。

## Solution

建立一個只供夫妻兩人使用的 LINE Official Account Bot，加入指定的專用記帳群組。Bot 讀取群組中的每則文字訊息：精確指令由程式直接處理，其餘內容交由 Gemini 免費層解析為結構化交易或查詢意圖。

當日期、收支方向、金額、分類與交易筆數都能唯一判斷，且通過程式規則驗證，系統直接入帳並回覆 LINE Flex Message 收據。若內容有歧義、無法分類、涉及高額交易或修改已關帳月份，系統先建立綁定原發訊者的候選操作，待使用者按鈕確認或補選後才寫入正式帳本。

交易帳本是唯一真相。共同基金餘額、月份狀態、結轉與圖表皆由帳本推導，並可從帳本重建。系統使用 Cloudflare Workers Free 接收 webhook 與執行排程、Cloudflare D1 Free 保存資料與短效 CSV、Gemini 免費層解析語意、QuickChart 免費服務產生匿名統計圖，並使用 LINE OA 免費方案回覆與提醒。

## User Stories

1. As a spouse, I want to record a shared expense in natural language, so that bookkeeping feels like sending a normal LINE message.
2. As a spouse, I want a clearly understood transaction to be recorded immediately, so that routine bookkeeping requires no confirmation step.
3. As a spouse, I want ambiguous transactions to wait for my confirmation, so that the system does not guess and corrupt the balance.
4. As a spouse, I want the system to understand Arabic numerals, currency notation, and Chinese number words, so that I can enter amounts naturally.
5. As a spouse, I want one message to contain multiple transactions, so that I can record several expenses at once.
6. As a spouse, I want an ambiguous item within a multi-transaction message to hold the whole batch for review, so that the system never records only part of what I intended.
7. As a spouse, I want every recorded transaction to show a concise receipt, so that I can immediately spot an interpretation error.
8. As a spouse, I want every receipt to show the date, direction, amount, category, note, and latest balance, so that the result is unambiguous.
9. As a spouse, I want the original LINE text kept with the transaction, so that later audits can explain how the transaction was interpreted.
10. As a spouse, I want expenses assigned only to the agreed category taxonomy, so that analysis remains consistent over time.
11. As a spouse, I want store names, people, and item details saved as notes, so that the fixed category taxonomy stays clean.
12. As a spouse, I want a choice of likely categories when Gemini cannot classify an expense uniquely, so that I can resolve ambiguity without retyping everything.
13. As a spouse, I want messages without a date to use the LINE event date in Asia/Taipei, so that ordinary entries remain concise.
14. As a spouse, I want a date such as `7/30` to resolve to the most recent occurrence that is not in the future, so that backdated entries work naturally.
15. As a spouse, I want future-dated transactions rejected, so that the ledger contains only actual transactions.
16. As a spouse, I want the system to support only integer New Taiwan Dollar amounts, so that money calculations stay simple and exact.
17. As a spouse, I want zero, negative, decimal, foreign-currency, or non-unique amounts rejected, so that invalid amounts never enter the ledger.
18. As a spouse, I want transactions of NT$10,000 or more to require confirmation, so that a large parsing error cannot be posted automatically.
19. As a spouse, I want to enter my contribution amount independently each month, so that the amount can change without an administrator updating configuration.
20. As a spouse, I want my first monthly contribution entry to both declare and confirm my contribution, so that there is no separate confirmation ritual.
21. As a spouse, I want to say that I will contribute zero this month, so that the month can still become active without creating a zero-dollar transaction.
22. As a spouse, I want a repeated contribution message clarified as either a correction or an additional top-up, so that duplicate deposits are not created accidentally.
23. As a spouse, I want temporary top-ups recorded separately from monthly contributions, so that they increase the balance without satisfying next month's contribution.
24. As a spouse, I want expenses recorded while one contribution is still missing, so that early-month spending is not lost.
25. As a spouse, I want the pre-activation balance clearly labelled as provisional, so that it is not confused with the formal available balance.
26. As a spouse, I want the month to become active only when both people have confirmed their monthly contribution or zero contribution, so that the formal balance has a shared starting point.
27. As a spouse, I want a reminder on the first day of the month, so that we remember to fund the shared account.
28. As a spouse, I want a second reminder on the third day only for anyone still missing, so that reminders are useful without becoming spam.
29. As a spouse, I want the month to close even if one contribution remains missing, so that later months are never blocked.
30. As a spouse, I want an incomplete contribution status shown in the closing report, so that missing funding remains visible.
31. As a spouse, I want the remaining balance carried into the next month automatically, so that funds do not reset at month boundaries.
32. As a spouse, I want a late expense posted to its actual historical date, so that monthly reporting remains accurate.
33. As a spouse, I want a backdated change to a closed month to show its effect before confirmation, so that I understand which balances will change.
34. As a spouse, I want only the original sender to confirm a pending historical change, so that another person cannot approve it accidentally.
35. As a spouse, I want a confirmed historical change to recompute the closed month, subsequent opening balance, and current balance, so that all months remain consistent.
36. As a spouse, I want audit history preserved when a transaction is edited or deleted, so that historical changes are explainable.
37. As a spouse, I want to manage only my own transactions, so that one person cannot silently alter the other's records.
38. As a spouse, I want to type `修改` and see my latest ten active transactions, so that I can quickly find a transaction to edit or delete.
39. As a spouse, I want edit, copy-transaction-content, and delete buttons on manageable transactions, so that corrections do not require memorizing identifiers or retyping the selected transaction.
40. As a spouse, I want an edit to accept a new natural-language description, so that correction uses the same interaction style as creation.
41. As a spouse, I want a deleted transaction marked void rather than physically removed, so that the audit trail remains intact.
45. As a spouse, I want the balance allowed to become negative, so that the ledger continues reflecting reality during overspending.
46. As a spouse, I want one alert when the active-month balance crosses below NT$1,000, NT$500, or NT$0, so that we know when a top-up may be needed.
47. As a spouse, I want only the lowest crossed threshold included when a single expense crosses multiple thresholds, so that the group is not flooded with alerts.
48. As a spouse, I want threshold alerts reset after the balance rises back above a threshold, so that a later downward crossing can alert again.
49. As a spouse, I want no low-balance warnings while the month is still awaiting contributions, so that provisional early-month values do not create false alarms.
50. As a spouse, I want to ask `餘額`, so that I can see the current balance and monthly contribution state.
51. As a spouse, I want to ask `最近紀錄`, so that I can view the latest ten transactions without entering edit mode.
52. As a spouse, I want to ask `本月明細`, so that I can review the current month's transactions and category subtotals.
53. As a spouse, I want to ask `說明`, so that I can discover available commands and natural-language examples.
54. As a spouse, I want exact commands processed without Gemini, so that command usage does not consume the AI quota.
55. As a spouse, I want fuzzy queries interpreted by Gemini, so that I can ask questions such as how much money remains in natural language.
56. As a spouse, I want `本月分析` to show a readable Flex ranking of major-category spending, so that I understand this month's spending mix on mobile.
57. As a spouse, I want `每月趨勢` to compare contributions, expenses, and closing balances over six months, so that I can see overall movement.
58. As a spouse, I want `分類趨勢` to compare major-category spending over six months, so that I can see which kinds of spending are changing.
59. As a spouse, I want charts rendered in a consistent mobile-friendly style, so that repeated reports are easy to compare.
60. As a spouse, I want each chart accompanied by a short deterministic summary, so that the key values are readable without inspecting the image closely.
61. As a spouse, I want chart links to expire after seven days, so that old financial visuals are not permanently public.
62. As a spouse, I want a closing report after each month, so that contributions, top-ups, other income, expenses, closing balance, carryover, largest category, completion state, and CSV status are visible together.
63. As a spouse, I want to download the current month as CSV from LINE, so that I retain a portable copy without configuring another service.
64. As a spouse, I want the CSV link to expire after ten minutes, so that financial exports are not permanently public.
65. As a spouse, I want to generate a fresh CSV after a correction, so that the download always reflects the current ledger.
66. As a spouse, I want duplicate LINE webhook deliveries ignored, so that retry behavior cannot double-charge the balance.
67. As a spouse, I want simultaneous messages processed in a deterministic order, so that receipts and balances never appear to go backward.
68. As a spouse, I want month-close jobs and user transactions serialized through the same group-level ordering rule, so that a boundary race cannot corrupt carryover.
69. As a spouse, I want a message sent before midnight assigned by LINE event time even if processing is delayed, so that infrastructure latency cannot move it into the wrong month.
70. As a spouse, I want a system-delayed month-end event incorporated without asking for historical confirmation, so that I am not penalized for webhook delivery delay.
71. As a spouse, I want a failed Gemini parse saved for safe retry without changing the balance, so that temporary AI outages do not lose intent or create uncertain entries.
72. As a spouse, I want a retry button for an unparsed message, so that I do not need to retype it after service recovery.
73. As a spouse, I want every pending operation bound to me and to a unique identifier, so that confirmations cannot apply to the wrong transaction.
74. As a spouse, I want pending candidates to expire, so that stale buttons cannot unexpectedly change the ledger later.
75. As a spouse, I want only our designated LINE group and two user IDs accepted, so that outsiders cannot consume quota or access financial data.
76. As a spouse, I want the Bot to suspend if an unapproved member joins the group, so that financial replies are not exposed to a third party.
77. As a spouse, I want the Bot to resume only after the outsider leaves, so that privacy is restored before processing restarts.
78. As a spouse, I want edited or unsent LINE messages to leave posted ledger entries unchanged, so that chat-history actions cannot silently rewrite accounting history.
79. As a spouse, I want only text input supported in MVP, so that image, receipt, and voice parsing do not introduce hidden costs and ambiguity.
80. As a spouse, I want unsupported non-text content not to affect the ledger, so that stickers and media cannot create transactions.
81. As a spouse, I want the system to begin with a zero opening balance, so that no historical import or reconciliation is required.
82. As a spouse, I want the system to remain free, so that no provider can automatically charge when a quota is exhausted.
83. As a spouse, I want the system to fail closed when a provider is unavailable or over quota, so that availability never takes priority over ledger correctness.

## Implementation Decisions

### Domain model and invariants

- The **Ledger** is the append-oriented source of truth. A mutable balance is never authoritative; any cached balance or month summary must be rebuildable from ledger entries.
- The **Fund Month** state is one of `awaiting_contributions`, `active`, or `closed`. A closed month may additionally carry an incomplete-contribution marker.
- A **Monthly Contribution Confirmation** belongs to one spouse and one fund month. It may reference a positive contribution transaction or explicitly represent a zero contribution.
- A **Top-up** increases the fund balance but never satisfies a future or current monthly contribution unless it was explicitly entered as the person's monthly contribution.
- Refund creation is not supported. The legacy `refund` ledger type remains readable only for backward compatibility.
- A **Transaction Revision** preserves the prior version. Delete is represented as a void revision, not physical deletion.
- Every ledger-affecting operation records the actor, original input text, LINE event identity, effective transaction date, creation time, revision lineage, and status.
- Amounts are positive integer TWD values. Transaction direction expresses whether the ledger increases or decreases; negative numeric amounts are invalid.
- The opening balance is NT$0 in the first enabled fund month. Historical imports are not supported.
- Payment actor is audit metadata only. Reports must not compare spouses or calculate reimbursement, debt, or settlement between them.

### Expense taxonomy

- Gemini must select exactly one of the following 5 major categories and 30 small categories for an expense. It must never invent a category.
  - 飲食：早餐、午餐、晚餐、飲料、甜點、零食
  - 生活：房貸、水電瓦斯、網路、修繕、管理費、停車費
  - 交通：計程車、汽車、機車、高鐵、火車、捷運
  - 娛樂：電影、影音、門票、聚會、旅遊
  - 購物：服飾、3C、家電、香菸、酒水、玩具、日用品
- Store names, people, brands, and item details belong in `note`, not in the taxonomy.
- If no category is uniquely defensible, no transaction is posted. The system returns two or three likely small-category buttons for the original sender.
- The taxonomy is fixed in MVP configuration and cannot be edited through LINE.

### Natural-language interpretation

- The LINE group is dedicated to bookkeeping. Every text message from an allowlisted user is inspected.
- Exact commands are matched locally before Gemini and do not consume AI quota.
- All other text is sent to Gemini as sanitized input. LINE user ID, group ID, and display-name mappings are not included. The fixed taxonomy and current interaction context may be included.
- Gemini must return structured output. Application validation, not Gemini's self-reported confidence, determines whether the result is unambiguous.
- A result may be posted directly only when transaction count, date, direction, amount, and category are unique, allowed, and mutually consistent.
- Multiple expenses in one message are supported, and the receipt shows the batch expense total. A message that mixes contributions and expenses is rejected with guidance to enter them separately. If any item is ambiguous, the entire batch remains pending until resolved and confirmed.
- A single transaction of NT$10,000 or more always becomes a candidate requiring explicit confirmation.
- Exact and fuzzy query intents may return answers, but a fuzzy result must never mutate the ledger unless it independently satisfies all transaction validation rules.
- Gemini use is limited to 100 calls per Asia/Taipei calendar day. No paid fallback model or paid tier may be configured. On exhaustion, the system refuses AI-dependent processing while exact commands remain available.
- Messages that could not be parsed are retained as failed events with no ledger effect and may be retried by the original sender.

### Dates and month boundaries

- All business dates use Asia/Taipei.
- When no date is present, use the LINE webhook event date.
- A month/day without a year resolves to the most recent occurrence that is not in the future.
- Explicit future transactions are rejected; scheduled future bookkeeping is outside MVP.
- A transaction belongs to a fund month by effective transaction date, not server processing date.
- Month close runs on the first day of the following month at 00:10 Asia/Taipei. It first drains already received events for the designated group.
- LINE event timestamp and event ID form the deterministic tie-break basis for ordering. The implementation must define a stable final tie-breaker for equal timestamps.
- A webhook event sent before midnight but redelivered after close is treated as infrastructure delay. If it was never applied, it is posted to its event-time month and dependent summaries are recomputed without user confirmation.
- A user-initiated backdated transaction targeting a closed month requires explicit same-sender confirmation before posting.
- Confirming a closed-month change recomputes the affected month's closing balance, all dependent opening balances, the current balance, summaries, threshold state where relevant, and the affected CSV.

### Contributions, activation, and balance alerts

- Each spouse chooses their monthly contribution amount in LINE. There is no configured fixed expected amount.
- A spouse's first clear monthly-contribution message both creates the contribution and marks that spouse complete for the month.
- `本月不存` or an equivalent clear statement records a zero-contribution confirmation without creating a money transaction.
- A repeated monthly-contribution statement must be disambiguated as a correction or an additional top-up.
- Expenses before both confirmations are posted normally, but balance responses are labelled provisional and low-balance alerts remain disabled.
- Once both spouses confirm, the month becomes active and the formal available balance is shown.
- Deleting a spouse's only monthly contribution confirmation returns an open month to `awaiting_contributions`; expenses remain and threshold alerts pause. Reconfirmation activates it again.
- At month close, the actual ledger is closed even if a contribution is missing. The month is marked incomplete and the actual closing balance carries forward.
- Balance may be negative. No expense is blocked for insufficient funds.
- In an active month, alerts trigger on downward crossings below NT$1,000, NT$500, and NT$0. If one operation crosses multiple thresholds, one response reports only the lowest resulting band.
- A threshold becomes eligible again only after the balance rises back above it.
- At a negative balance, the reply explicitly shows the minimum amount required to return to zero; it does not allocate that amount between spouses.

### LINE interaction contract

- Only one configured LINE group ID and two configured LINE user IDs are authorized.
- The webhook must validate the LINE signature before any parsing, storage, quota use, or response.
- `webhookEventId` provides idempotency. Redelivery must not create a second candidate, ledger entry, reply state, or balance change.
- Exact commands include `餘額`, `最近紀錄`, `修改`, `本月明細`, `本月分析`, `每月趨勢`, `分類趨勢`, and `說明`.
- `餘額` shows formal or provisional balance plus both monthly contribution states.
- `最近紀錄` shows the latest ten visible transactions without entering an edit workflow.
- `修改` shows the original sender's latest ten active transactions with `編輯`, `複製內容`, and `刪除` actions. Copy reconstructs only the selected transaction even when the original message contained a batch, uses LINE's clipboard action, and does not send the copied text into the group.
- An edit action opens a ten-minute same-sender context tied to one transaction ID. The sender then supplies a complete replacement description in natural language.
- When an edited description requires confirmation, show before-and-after summaries with `確認修改` and `取消修改` actions. Cancel removes only the pending replacement and leaves the original transaction unchanged.
- A standard ambiguous transaction candidate is tied to its sender, group, payload, and unique ID and expires after ten minutes.
- A closed-month confirmation is tied to its sender, group, exact proposed change, and unique confirmation code and expires after five minutes.
- Buttons use LINE postback data with opaque operation IDs. Operation IDs must never appear in button display text or ordinary chat replies.
- Successful posts return a compact Flex Message receipt containing effective date, direction, amount, major and small category when applicable, note, transaction sequence, and latest balance. It includes management actions allowed for that transaction.
- Text is the fallback if Flex Message delivery or validation fails. Visual template changes must not alter transaction logic or stored data.
- LINE edit and unsend webhook events do not mutate the ledger. Ledger corrections use explicit Bot workflows only.
- Non-text input does not affect the ledger and receives a minimal reply stating that MVP supports text only.
- If a non-allowlisted member joins the configured group, the group becomes privacy-suspended. While suspended, no message content is sent to Gemini, no transaction is created, and no financial response is returned. Processing resumes only after all group members are allowlisted again.
- The implementation must serialize ledger-affecting work per group. A D1-backed inbox, deterministic claim/lock protocol, or equivalent free-tier-compatible mechanism must prevent simultaneous workers and scheduled jobs from committing out of order.

### LINE cost and delivery behavior

- The LINE OA remains on Taiwan's free light-usage plan. Additional paid messages are disabled.
- Replies to inbound events use reply messages and must be attempted within LINE's one-minute reply-token lifetime.
- Processing should target completion within 50 seconds. A reply timeout must not roll back or repeat an otherwise committed transaction.
- The system must not fall back to a chargeable push message for an expired transaction reply. The undelivered receipt is retained and bundled into the next eligible reply interaction.
- Scheduled reminders and closing reports require push messages. Before pushing, check the current monthly push allowance. If none remains, complete the underlying accounting/export action but skip the notification.
- For the two-person group, push-message accounting must use LINE's recipient-based count, not request or bubble count.
- The system must never upgrade the LINE plan, enable add-on messages, or send through another paid channel.

### Scheduled behavior

- On each month's first day at 09:00 Asia/Taipei, send one group reminder identifying both monthly contribution states.
- On the third day at 09:00, send a second reminder only if at least one spouse remains incomplete; identify only the incomplete spouse or spouses.
- No further automatic contribution reminders occur that month.
- Month close at 00:10 on the first day creates an idempotent close record, calculates actual contribution total, top-ups and other income, expense total, closing balance, carryover, largest expense category, and contribution completion state.
- The closing report states that CSV is available from the detail menu. It does not automatically include the three analysis charts.
- Scheduled jobs must be safe to run more than once. Re-execution cannot duplicate close records, carryovers, CSV files, reminders, or push messages.

### Reports and charts

- `本月分析` renders a Flex ranking of non-zero major-category net spending with amount and percentage; it does not generate an image.
- `每月趨勢` renders six months of contribution and expense bars with a closing-balance line.
- `分類趨勢` renders six months of major-category net spending as stacked bars.
- Charts use fixed mobile dimensions, typography, colors, title placement, category ordering, currency formatting, and empty-state behavior.
- Statistical calculations are deterministic application code over D1 data. Gemini is not allowed to calculate report totals or render images.
- Chart text contains two or three deterministic statements derived from the same statistics payload, including the most relevant total and comparison. Gemini is not required for chart summaries.
- QuickChart receives only an anonymous chart configuration containing aggregated labels and values. It receives no user IDs, group IDs, original messages, notes, transaction IDs, or CSV contents.
- A chart URL contains an opaque random token and tamper-resistant signature, not raw statistics. The Worker validates the token and seven-day expiry before proxying the generated PNG. Expired or invalid URLs return 404.
- If QuickChart is unavailable, return a text-only report and clearly mark chart generation as temporarily unavailable. Do not switch to a paid renderer.

### Short-lived CSV download

- The detail menu creates an on-demand CSV for the current month named `共同基金_YYYY-MM.csv`.
- The CSV contains effective date, transaction direction/type, amount, category, note, actor identity, original input, creation time, revision status, and related transaction where applicable.
- CSV output uses spreadsheet-friendly UTF-8 with BOM and stable column order.
- The download URL uses an opaque token and HMAC signature, expires after ten minutes, and is served with private no-store caching.
- A correction is reflected the next time a download link is generated; no external OAuth or file synchronization is required.
- No additional full-ledger backup, encrypted JSON backup, or historical import is included in MVP.

### Free-tier architecture and failure policy

- Runtime and HTTP ingress use Cloudflare Workers Free. No Workers Paid plan or paid fallback may be enabled.
- Persistent data uses Cloudflare D1 Free. The schema and indexes must keep expected couple-level reads and writes far below free limits.
- Scheduled work uses no more than the free Cron Trigger allowance.
- Temporary chart images are not stored in a billable object store; the Worker proxies the free renderer through signed, expiring routes.
- Gemini uses an API project with no billing account attached. The daily application limit is enforced before the outbound call.
- CSV download uses existing Workers and D1 free-tier resources with no external storage service.
- Every provider integration fails closed: quota exhaustion or outage produces a recorded, retryable operational state and never silently changes the ledger.
- A provider's free-tier policy may change. Deployment documentation must list every account setting that prevents automatic paid upgrade and the exact failure symptom expected at each quota boundary.

### Data retention and privacy

- The transaction's original input text is retained with the transaction for the life of the ledger.
- Full LINE webhook payloads and full Gemini responses are operational data and must be deleted after 30 days.
- General non-transaction text may be sent to Gemini because the group is dedicated to bookkeeping, but it is not retained as ledger data. It may exist only in the bounded operational record needed for idempotency and the 30-day troubleshooting window.
- Gemini input excludes LINE user IDs, group ID, and display-name mappings.
- Financial responses are visible only in the configured two-person group while its membership is valid.
- Secrets never appear in D1, logs, CSV, chart configuration, or LINE messages.

### Observability and operational controls

- Persist enough structured operational status to distinguish `received`, `processing`, `candidate`, `posted`, `failed_retryable`, `failed_final`, and `reply_pending` without treating operational state as ledger truth.
- Logging must redact message text, LINE tokens, Gemini keys, download signatures, and export contents where not required.
- Expose no public administration UI in MVP. Allowlist values, secret material, destination folder, and fixed taxonomy are deployment configuration.
- Operational retries must use bounded attempts and idempotency keys. A retry may repair a missing response, CSV, chart, or summary but may not duplicate a ledger mutation.

## Testing Decisions

### Primary test seam

- Use one highest-level application seam: submit a signed LINE webhook event (or scheduled-job event) to the Worker handler with controlled external adapters, then assert observable LINE output, D1 ledger state, fund-month state, CSV downloads, and chart requests.
- The seam should exercise real routing, authorization, idempotency, semantic-result validation, domain rules, transaction ordering, reporting calculations, and response construction. Gemini, LINE network calls, QuickChart, wall clock, and random token generation are replaced only at their external boundaries.
- Tests assert external behavior and durable state, not private function calls, internal class structure, SQL statement count, or implementation-specific call order unless ordering is itself a domain requirement.
- There is no prior art in the repository because it is empty. The new suite establishes this Worker-handler seam as the project standard.

### Required acceptance coverage

- Both spouses submit monthly contributions; the month transitions from awaiting to active and the formal balance is correct.
- One spouse confirms zero contribution; the month can still activate without a zero-dollar ledger entry.
- An expense before activation is posted, labelled provisional, and emits no threshold alert.
- Clear single and multi-transaction messages post exactly once with correct receipts.
- An ambiguous category produces two or three allowed choices and no ledger effect before selection.
- An ambiguous batch posts nothing until the whole batch is resolved.
- Amount, date, direction, category, and future-date validation reject invalid structured output.
- A transaction at or above NT$10,000 requires same-sender confirmation.
- Repeated monthly-contribution wording asks correction versus top-up and never duplicates funds silently.
- Gemini daily quota exhaustion prevents an outbound call and leaves exact commands operational.
- Gemini failure produces no ledger mutation and supports same-sender retry.
- Duplicate and redelivered webhooks create one event, one ledger effect, and at most one durable reply state.
- Concurrent spouse messages commit in deterministic event order and show monotonic sequence numbers and balances.
- Month close and a boundary transaction cannot race into inconsistent carryover.
- A delayed pre-midnight webhook is assigned to the prior month and reconciled without user confirmation.
- A user-entered closed-month transaction requires the same sender's confirmation and then recomputes all dependent balances.
- Expired, wrong-user, wrong-group, replayed, and mismatched confirmations are rejected.
- Edit creates a new revision, delete voids without physical removal, and each action preserves original history.
- Deleting the only monthly contribution confirmation returns the open month to awaiting state.
- Legacy refund entries remain included in historical balance and net-category calculations but no new refund can be created.
- Balance crossings below NT$1,000, NT$500, and NT$0 alert once per eligible crossing; one large expense produces one lowest-band alert.
- Raising the balance rearms only the appropriate thresholds.
- `餘額`, `最近紀錄`, `修改`, `本月明細`, and `說明` return the agreed observable content.
- `修改` lists only the requesting spouse's latest ten active transactions and actions target the selected ID.
- LINE edit and unsend events never mutate an existing transaction.
- An unauthorized group or user causes no Gemini call, D1 transaction, or financial response.
- A non-allowlisted member joining suspends processing; leaving restores it.
- Month close remains idempotent when triggered repeatedly and closes an incomplete-contribution month correctly.
- Monthly reminders are emitted only at the agreed times and only for missing contributions.
- Exhausted LINE push allowance skips reminders and closing push without preventing close or CSV generation.
- An expired reply token never causes a paid push; a pending receipt is delivered with the next eligible reply.
- All three chart commands calculate numbers that match the ledger and send only aggregate anonymous data to QuickChart.
- Invalid or expired chart tokens return 404; valid tokens proxy a PNG and reveal no financial values in the URL.
- CSV download uses the stable filename and schema; a newly generated export reflects historical corrections.
- Invalid, tampered, and expired CSV links return 404 without exposing export contents.
- Full webhook and Gemini operational payloads expire after 30 days while transaction original input remains.
- Provider outage and quota tests prove that every integration fails closed without invoking a paid fallback.

## Out of Scope

- A Web administration console or mobile application.
- Bank account, credit card, payment-provider, or open-banking reconciliation.
- Tracking who owes whom, reimbursement, split ratios, or spouse-to-spouse settlement.
- Per-person spending comparison or `誰花多少` reports.
- Budget envelopes, spending approval, or blocking expenses when the balance is insufficient.
- Scheduled future transactions or recurring expenses other than system reminders and month close.
- Receipt image recognition, invoice OCR, voice messages, audio transcription, stickers, or other non-text bookkeeping.
- User-editable categories or category management through LINE.
- Additional households, groups, users, currencies, or languages beyond this designated two-person TWD ledger.
- Historical transaction import or non-zero opening balance.
- Guaranteed availability, paid service failover, or any feature that can automatically create a charge.
- A full encrypted backup or one-click restoration workflow beyond on-demand CSV exports.
- Automatic chart generation in the closing report.
- AI-generated charts or AI-calculated financial totals.
- Permanent public chart hosting.
- Visual polish beyond one maintainable Flex Message system and fixed mobile chart templates.

## Further Notes

- The product name used in examples is `共同基金`; final OA display name and visual branding may be adjusted without changing domain behavior.
- The repository is currently empty, with no ADRs, domain glossary, code conventions, test precedent, Git remote, or issue tracker configuration. This spec establishes the initial domain vocabulary and test seam.
- The implementation should begin by converting the domain invariants and acceptance coverage into executable tests at the Worker-handler seam, then add provider adapters behind that seam.
- Free quotas and provider terms are external constraints rather than product guarantees. The implementation must encode hard application limits and fail-closed behavior; deployment documentation must also explain how to verify that billing remains disabled.
- QuickChart is an MVP dependency chosen to avoid paid image-rendering infrastructure. If it becomes unavailable or changes terms, text analysis remains functional while charts fail closed.
- The issue-tracker publication and `ready-for-agent` label could not be completed because this repository has no configured remote or issue tracker. The Markdown specification remains the authoritative handoff artifact until a tracker is configured.
