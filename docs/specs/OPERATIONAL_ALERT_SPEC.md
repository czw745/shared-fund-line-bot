# LINE 異常通知與端到端驗證規格

## 目標

在維持免費額度與帳本正確性的前提下，讓兩位使用者能主動得知需要處理的系統異常。

## 公開測試介面

- 簽章 LINE webhook：觀察 Reply／Push 與後續 LINE 查詢結果。
- Cloudflare scheduled event：觀察月底關帳、跨月結轉與 Push 結果。

## 異常通知

- 只通知 `failed_retryable` 與 `reply_pending`。
- 通知發送到既有共同基金群組，不包含訊息原文、User ID、token 或內部錯誤內容。
- 同一錯誤代碼一小時最多通知一次。
- 發送前確認 LINE Push 至少剩餘 2 則（兩位群組成員的 recipient-based count）。
- 通知或額度查詢失敗不得改變帳本、重試原交易或覆蓋原事件狀態。

## D1 備份

- 使用 Wrangler 從正式 D1 手動匯出 SQL。
- 備份存放在本機 `backups/`，不得加入 Git。
- 匯出後確認檔案非空且包含核心資料表結構。
