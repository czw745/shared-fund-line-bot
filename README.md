# 屁屁五十元｜LINE 共同基金記帳 Bot

兩人直接在指定 LINE 群組用自然語言記錄共同基金。Bot 會解析存入與支出、維護共同餘額、提供修改／刪除、圖表、月底關帳及短效 CSV 下載。

## 主要功能

- 自然語言與多筆記帳，例如 `8/3 晚餐 280，飲料 60`
- 兩位成員各自申報每月存入，完成後正式啟用當月帳本
- 單筆 NT$10,000 以上須確認，避免高額誤入帳
- 固定大小分類、低餘額提醒與跨月結轉
- 最近紀錄、本月明細、交易編輯／刪除及記錄者名稱
- 本月分析、每月趨勢與分類趨勢
- 10 分鐘有效的簽章 CSV 下載連結，不需要 Google OAuth
- Gemini、LINE Push 與最近 24 小時系統健康度查詢

使用方式見 [USER_GUIDE.md](USER_GUIDE.md)，完整產品規格見 [MVP_SPEC.md](MVP_SPEC.md)。

## 架構

```text
LINE Group → Cloudflare Worker → D1 ledger
                         ├── Gemini：自然語言解析
                         ├── QuickChart：匿名彙總圖表
                         └── Signed URL：短效 CSV 下載
```

帳本是唯一真相；餘額與報表都由 D1 ledger 推導。外部服務失敗時採 fail-closed，不切換付費方案，也不重複入帳。

## 本機開發

需求：Node.js 22+。

```sh
npm install
cp .dev.vars.example .dev.vars
npm run typecheck
npm test
```

測試從公開 Worker handler 送入簽章 webhook 或 scheduled event，驗證 LINE 回覆與持久狀態。Gemini、LINE、QuickChart、時間與亂數只在外部邊界替換。

## 部署

1. 建立 Cloudflare Free 帳號，保持 Workers Free plan。
2. 建立 D1：`npx wrangler d1 create shared-fund-ledger`，將 database ID 填入 `wrangler.toml`。
3. 套用 migration：`npx wrangler d1 migrations apply shared-fund-ledger --remote`。
4. 建立 LINE OA Messaging API channel，允許加入群組並開啟 webhook redelivery。
5. 建立未連結 Billing 的 Gemini API key。
6. 依 `.dev.vars.example` 用 `npx wrangler secret put <NAME>` 設定 secrets。
7. `CHART_SIGNING_SECRET` 使用至少 32 bytes 隨機值；`PUBLIC_BASE_URL` 設為 Worker HTTPS origin。
8. 執行 `npm run deploy`，把 `<worker-origin>/webhook` 設為 LINE webhook URL。

## 必要設定

| 變數 | 用途 |
|---|---|
| `ALLOWED_GROUP_ID` | 唯一授權 LINE 群組 |
| `ALLOWED_USER_IDS` | 兩個授權 User ID，以逗號分隔 |
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

## 安全與免費額度

- 僅接受指定群組與兩位成員；第三人加入時暫停財務處理
- LINE webhook 驗證簽章，事件使用 `webhookEventId` 防止重複入帳
- 圖表連結 7 天到期；CSV 連結 10 分鐘到期並禁止快取
- Gemini 每日到達內部上限後停止 AI 解析，精確指令仍可用
- LINE Reply 失敗不改用可能計費的 Push，收據於下次互動補送
- LINE Push 額度不足時跳過提醒，但關帳與結轉仍會完成
- QuickChart 失敗時退回文字統計，不使用付費 renderer
- webhook 稽核表不保存完整 LINE 訊息內容

## 驗證

```sh
npm run typecheck
npm test
```

正式環境 smoke test：`說明` → 兩人存入 → 一般與高額支出 → `餘額` → `明細` → 修改／刪除 → CSV 下載 → 三種圖表 → `系統狀態`。
