# LINE Webhook 非同步處理修正規格

## 問題

LINE 在 webhook 約 2 秒後關閉 HTTP 連線。目前 Worker 在回覆 HTTP 200 前同步等待 Gemini，連線關閉後 Cloudflare 將執行標示為 `canceled`，因此無法完成解析、D1 入帳與 LINE reply。

## 目標

Webhook 驗證簽章與取得 request body 後立即回 HTTP 200，實際事件處理由 Cloudflare `ExecutionContext.waitUntil()` 在背景完成，並保留現有幂等、群組鎖與 fail-closed 行為。

## 必要變更

1. `src/index.ts`
   - Worker `fetch` 接收第三個 `ExecutionContext` 參數。
   - 將背景處理 Promise 交給 `ctx.waitUntil()`。
2. `src/app.ts`
   - 分離「簽章／JSON 驗證」與「處理 webhook events」。
   - 無效簽章仍同步回 401，無效 JSON 回 400。
   - 有效 webhook 將處理 Promise 交給 waitUntil 後立即回 200。
3. `src/types.ts`
   - 更新 Worker app seam，讓測試可注入 waitUntil 收集器。
4. `test/`
   - 新增回歸測試：Gemini Promise 未完成時，fetch 已回 200。
   - 執行收集到的背景 Promise 後，應只入帳一次且只回覆一次。
   - 重複 webhook 仍不可產生第二筆交易。
   - Gemini 失敗時不入帳，並保留同一使用者的重試候選。

## 驗收條件

- `npm run typecheck` 通過。
- 全部測試通過。
- LINE 輸入 `我這個月存入 8000` 可在 reply token 有效期內完成入帳並回覆收據。
- Cloudflare 日誌 outcome 不再是 `canceled`。
- 同一 `webhookEventId` 重送不重複入帳。
- 不新增付費服務或 push-message fallback。
