# LINE 共同基金記帳 Bot｜部署與維運

## 部署

1. 建立 Cloudflare Free 帳號，保持 Workers Free plan，不綁定或升級 Workers Paid。
2. 複製 `wrangler.toml.example` 為不納入版本控制的 `wrangler.toml`。
3. 建立 D1：`npx wrangler d1 create shared-fund-ledger`，將 database ID 填入本機 `wrangler.toml`。
4. 套用 migration：`npx wrangler d1 migrations apply shared-fund-ledger --remote`。
5. 建立 LINE OA 輕用量方案的 Messaging API channel，關閉加購訊息，允許加入群組並開啟 webhook redelivery。
6. 建立未連結 Billing、未申請付費 quota increase 的 Gemini API key。
7. 依 `.dev.vars.example` 用 `npx wrangler secret put <NAME>` 設定 secrets。
8. `CHART_SIGNING_SECRET` 使用至少 32 bytes 隨機值；`PUBLIC_BASE_URL` 設為 Worker HTTPS origin。
9. 在 GitHub repository Actions secrets 設定 `CLOUDFLARE_ACCOUNT_ID`、最小權限的 `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_D1_DATABASE_ID`。Database ID 不是憑證，但以 secret 保存可避免把正式環境識別碼提交到公開 repository。
10. 推送至 `main`；GitHub Actions 會先執行測試與型別檢查，產生部署用 `wrangler.toml`，成功後自動部署。
11. 把 `<worker-origin>/webhook` 設為 LINE webhook URL。

`main` 是正式環境的唯一版本來源。`npm run deploy` 僅供緊急人工部署，使用後必須將同一版本回補至 `main`。

## 必要設定

| 變數 | 用途 |
|---|---|
| `ALLOWED_GROUP_ID` | 唯一授權 LINE 群組 |
| `ALLOWED_USER_IDS` | 兩個授權 User ID，以逗號分隔 |
| `MEMBER_NAME_OVERRIDES` | 選填的固定顯示名稱 JSON，優先於 LINE Profile |
| `LINE_CHANNEL_SECRET` | 驗證 LINE webhook 簽章 |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Reply、Profile 與 Push API |
| `GEMINI_API_KEY` | 自然語言解析 |
| `CHART_SIGNING_SECRET` | 保護圖表與 CSV 短效 URL |
| `PUBLIC_BASE_URL` | Worker 公開 HTTPS origin |

非敏感額度與時區設定在 `wrangler.toml`。

## 排程

- 每月 1 日 00:10（Asia/Taipei）：關帳並結轉餘額
- 每月 1、3 日 09:00：提醒尚未完成存入的成員

排程具冪等性，重複執行不會重複關帳或推播。

Cloudflare cron 使用 UTC。關帳 trigger 設為 `10 16 28-31 * *`，涵蓋各月最後一天（含閏年）；handler 僅在 Asia/Taipei 每月 1 日 00:10 執行關帳，其餘日期略過。不可使用 `10 16 1 * *`，那是台北每月 2 日 00:10，會被 handler 跳過。

## 安全與資料處理

- 僅接受指定群組與兩位成員；群組出現未授權成員時暫停財務處理
- LINE webhook 驗證簽章，事件使用 `webhookEventId` 防止重複入帳
- 成員顯示名稱優先使用 `MEMBER_NAME_OVERRIDES`，未設定時才讀取並快取 LINE Profile
- 群組分類規則最多保存 100 筆，採最長關鍵字優先；不明確時回退 Gemini
- 圖表連結 7 天到期；CSV 連結 10 分鐘到期並禁止快取
- webhook 稽核表不保存完整 LINE 訊息內容
- 本地財務洞察不會把彙總帳務資料送往 Gemini

## 免費額度保護

- Gemini 每日到達內部上限後停止 AI 解析，精確指令與明確的已學習分類仍可用
- LINE Reply 失敗不改用可能計費的 Push，收據於下次互動補送
- LINE Push 額度不足時跳過提醒，但關帳與結轉仍會完成
- 可重試錯誤或收據待補送時使用既有 Push 通知；同類錯誤一小時最多一次
- QuickChart 失敗時退回文字統計，不使用付費 renderer
- 專案不含自動升級、加購或付費 fallback 程式

## 部署後檢查

1. Cloudflare Dashboard → **Billing → Subscriptions**：確認只有 Workers Free。
2. Cloudflare Dashboard → **Workers & Pages → shared-fund-line-bot → Metrics**：確認請求量仍在免費額度內。
3. Cloudflare Dashboard → **Storage & databases → D1 → shared-fund-ledger → Metrics**：檢查 rows read、rows written 與 storage。
4. Google Cloud Console → **Billing**：確認 Gemini API 專案未連結 Billing account。
5. LINE Official Account Manager → **設定 → 月費方案／用量**：確認使用輕用量方案且未啟用加購訊息。

## 額度耗盡時

- Workers Free 額度用完：webhook 暫時失敗，不新增帳本，等待 Cloudflare 額度重設。
- D1 額度或容量用完：查詢或寫入失敗，既有資料不會自動刪除。
- Gemini 達每日 100 次內部上限：需要 Gemini 的自然語言記帳停止，選單與本地功能仍可用。
- LINE Reply token 失效：已完成收據保留到下一次互動補送。
- LINE Push 月額度不足：跳過提醒與通知，不影響關帳和結轉。
- QuickChart 無法使用：回覆文字或 Flex 統計。

## 驗證

```sh
npm run typecheck
npm test
```

正式環境 smoke test：`說明` → 兩人存入 → 一般與高額支出 → `餘額` → `明細` → 修改／刪除 → CSV 下載 → 三種分析功能 → `系統狀態`。
