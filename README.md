# LINE 共同基金記帳 Bot

兩人直接在指定 LINE 群組用自然語言記錄共同基金。Bot 會解析存入與支出、維護共同餘額，並提供交易管理、圖表、本地財務洞察、月底關帳及 CSV 下載。

本專案供自行部署；每個部署對應一個指定 LINE 群組及兩位授權成員，不提供多人共用的代管服務。

## 功能摘要

- 自然語言與多筆記帳，例如 `8/3 晚餐 280，飲料 60`
- 兩位成員分別申報每月存入，共用基金餘額
- 高額交易、模糊分類及跨月修改確認
- Flex 明細、分頁、編輯、複製內容與刪除
- 低餘額提醒、月底關帳與短效 CSV 下載
- 本月分析、每月趨勢、分類趨勢及本地財務洞察
- 群組共用分類學習，明確交易可在本地直接判斷
- Gemini、LINE Push、分類規則與系統健康度查詢

## 操作入口

在 LINE 群組輸入 `說明`，即可開啟「餘額、明細、圖表、系統狀態」Flex 主選單。

完整說明：

- [使用手冊](docs/USER_GUIDE.md)
- [產品規格](docs/MVP_SPEC.md)
- [部署與維運](docs/OPERATIONS.md)
- [歷次技術規格](docs/specs/)

## 架構

```text
LINE Group → Cloudflare Worker → D1 ledger
                         ├── Local parser：精確指令與已學習分類
                         ├── Gemini：其餘自然語言交易解析
                         ├── Local insights：彙總財務洞察
                         ├── QuickChart：匿名彙總圖表
                         └── Signed URL：短效 CSV 下載
```

帳本是唯一真相；餘額、報表與洞察都由 D1 ledger 推導。一般自然語言交易內容可能送往 Gemini 解析，但彙總財務資料與洞察不會送往 Gemini。

## 本機驗證

需求：Node.js 22+。

```sh
npm install
cp .dev.vars.example .dev.vars
cp wrangler.toml.example wrangler.toml
npm run typecheck
npm test
```

建立自己的 D1 database 後，將其 ID 填入本機 `wrangler.toml`。正式部署所需的完整設定與 secrets 請參閱[部署與維運](docs/OPERATIONS.md)。

自動測試涵蓋 webhook、記帳與確認、交易管理、Flex 分頁與降級、分類學習、本地洞察、CSV、排程及異常通知。

正式版本由 GitHub Actions 在 `main` 通過測試與型別檢查後自動部署至 Cloudflare Worker。

## 授權與貢獻

本專案採用 [MIT License](LICENSE)。提交修改前請閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)；安全問題請依 [SECURITY.md](SECURITY.md) 私下回報。
