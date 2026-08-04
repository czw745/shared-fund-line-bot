# 夫妻共同基金 LINE 記帳 Bot

以 LINE 群組作為入口的兩人共同基金帳本。Cloudflare Worker 驗證 LINE webhook，Gemini 將自然語言轉成結構化交易，D1 保存 append-oriented ledger；月底關帳後把 CSV 更新到 Google Drive，分析圖由匿名彙總資料產生。

完整產品決策見 `MVP_SPEC.md`，實作 tickets 見 `.scratch/shared-fund-line-bot/issues/`。

## 開發

需求：Node.js 22+。

```sh
npm install
cp .dev.vars.example .dev.vars
npm run typecheck
npm test
```

測試只走公開 Worker-handler seam：送入已簽章 LINE webhook 或 scheduled event，觀察 LINE 輸出與持久狀態。Gemini、LINE、Google Drive、QuickChart、時間與亂數只在外部邊界替換。

## 零費用部署

1. 建立 Cloudflare Free 帳號，確認 Workers plan 為 Free，且未升級 Paid。
2. 建立 D1：`npx wrangler d1 create shared-fund-ledger`，把 database ID 填入 `wrangler.toml`。
3. 套用 migration：`npx wrangler d1 migrations apply shared-fund-ledger --remote`。
4. 建立台灣 LINE OA 輕用量免費方案與 Messaging API channel，關閉加購訊息，開啟允許加入群組與 webhook redelivery。
5. 建立未連結 Billing 的 Gemini API key。程式在 Asia/Taipei 每日第 100 次後停止 AI 呼叫。
6. 在 Google Cloud 建立 Desktop/Web OAuth client，啟用 Drive API；以一次性授權取得 refresh token，授權範圍只需 Drive 檔案建立與更新。不要替該專案啟用付費 quota increase。
7. 建立一個 Drive 資料夾並取得 folder ID。
8. 以 `npx wrangler secret put <NAME>` 設定 `.dev.vars.example` 中所有敏感值；非敏感免費額度設定已在 `wrangler.toml`。
9. 產生至少 32 bytes 的 `CHART_SIGNING_SECRET`，並將部署後的 Worker HTTPS origin 設為 `PUBLIC_BASE_URL`。
10. `npm run deploy`，把 `<worker-origin>/webhook` 填入 LINE Developers Console，完成 webhook 驗證後再邀請 OA 進指定群組。

Google refresh token 不寫入 D1、repo 或 CSV，只能放 Cloudflare Secret。若要重新授權，在 Google OAuth 流程取得新 refresh token後重新執行 `wrangler secret put GOOGLE_REFRESH_TOKEN`。

## 必要設定

- `ALLOWED_GROUP_ID`：唯一允許的 LINE 群組。
- `ALLOWED_USER_IDS`：兩個 LINE user ID，以逗號分隔。
- `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`：webhook 驗證與回覆。
- `GEMINI_API_KEY`：必須使用未綁 Billing 的免費專案。
- `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`GOOGLE_REFRESH_TOKEN`、`GOOGLE_DRIVE_FOLDER_ID`：月底 CSV。
- `CHART_SIGNING_SECRET`、`PUBLIC_BASE_URL`：七天到期的圖表 URL。

## Fail-closed 行為

- Workers 或 D1 免費額度耗盡：請求失敗，不切換付費。
- Gemini 達每日 100 次：自然語言暫停；精確指令仍可用。
- LINE reply token 逾時：不改用計費 push；收據留待下一次免費 reply 一起送。
- LINE 主動訊息額度不足：跳過提醒／結算推播，但仍關帳與匯出 CSV。
- Drive 失敗：關帳照常完成，重試三次後以 `重新上傳` 修復。
- QuickChart 失敗：只回文字統計，不使用付費 renderer。
- 第三人加入群組：立即暫停 AI、記帳與財務回覆，離開後恢復。

## 上線 smoke test

使用測試資料依序驗證：`說明`、兩人存入／零元確認、清楚支出、`餘額`、`修改`、退款、低餘額提醒、月底測試排程、Drive CSV、三種圖表、第三人加入暫停。完成後將測試交易作廢，不使用真實財務資料。
