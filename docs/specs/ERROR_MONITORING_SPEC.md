# Webhook 錯誤監控規格

## 目標

讓正式環境能從 D1 判斷事件失敗類型，不需依靠截圖猜測，同時避免保存敏感錯誤內容。

## 行為

- `webhook_events` 新增 nullable `error_code`。
- 成功事件清除錯誤碼。
- LINE Reply 失敗且已進 outbox：`line_reply_failed`。
- 群組鎖取得逾時：`group_lock_timeout`。
- 外部請求逾時：`external_timeout`。
- 外部服務限流：`provider_rate_limited`。
- 未支援或群組暫停使用固定錯誤碼。
- 不保存原始 exception message、財務文字、Token 或 API key。
- `webhook_events` 不重複保存整包 LINE webhook payload；交易稽核原文由 ledger 保存，解析失敗原文只存在有期限的 retry candidate。

## 驗收

- Reply 失敗事件同時保存 `reply_pending` 與 `line_reply_failed`。
- 事件恢復成功後錯誤碼可清除。
- migration 可安全套用既有 D1。
- 完整測試與型別檢查通過。
