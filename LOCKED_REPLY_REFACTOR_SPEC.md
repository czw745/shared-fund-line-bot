# 群組鎖與 LINE 回覆解耦規格

## 目標

避免 LINE Reply API 延遲或失敗時占用群組鎖，導致後續按鈕與記帳事件連鎖失敗。

## 行為

- 群組鎖內只完成狀態讀寫與產生回覆內容。
- 釋放群組鎖後才呼叫 LINE Reply API。
- LINE Reply API 最長等待 5 秒。
- Reply 失敗時，重新取得短鎖將回覆寫入 `pendingReceipts`，事件標記 `reply_pending`。
- 待補送收據保存原事件 ID；下次 Reply 成功後，原事件改為 `posted` 並清除錯誤代碼，避免健康度永久誤報。
- 下一次互動把待補內容合併到本次 Reply，不使用額外 Push。
- 文字訊息與 postback 使用相同的回覆失敗處理。
- D1 群組鎖等待時間由約 1 秒提高到約 5 秒。

## 驗收

- 第一個 LINE Reply 卡住時，第二個同群組事件仍可完成。
- postback Reply 失敗後，下一次互動能補顯示內容。
- 不新增 LINE Push 用量。
- 完整測試與型別檢查通過。
