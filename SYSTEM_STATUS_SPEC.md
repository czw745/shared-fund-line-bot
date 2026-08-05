# 系統狀態選單規格

## 目標

從 `說明` 主選單直接查看 Bot 可控的 Gemini、LINE Push 使用量與近期處理健康度。

## 行為

- `說明` 主選單新增 `系統狀態` 按鈕。
- 顯示 Gemini 今日 Bot 呼叫次數／內部每日上限。
- 即時呼叫 LINE quota API，顯示本月 Push 已用、剩餘與上限。
- LINE quota API 暫時失敗時，Gemini 狀態仍可顯示並標註 LINE 無法取得。
- 顯示最近 24 小時 webhook 錯誤筆數；無錯誤時顯示「運作正常」。
- 有錯誤時依標準錯誤代碼彙總，不顯示訊息原文、User ID 或內部亂數。
- 只有 `failed_retryable` 與尚未補送的 `reply_pending` 算作異常；無效指令、非文字訊息與隱私暫停等預期拒絕不列入健康度。
- 查詢本身不呼叫 Gemini，也不計入 LINE Push（使用 Reply 回覆）。

## 驗收

- 主選單包含系統狀態按鈕。
- postback 能直接取得狀態，不進入 Gemini。
- 可從 LINE 區分近期正常、LINE 回覆失敗、外部服務逾時與群組鎖逾時。
- 完整測試與型別檢查通過。
