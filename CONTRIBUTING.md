# Contributing

感謝協助改善 LINE 共同基金記帳 Bot。

## 開發流程

1. 使用 Node.js 22 或更新版本。
2. 執行 `npm ci`。
3. 複製 `.dev.vars.example` 為 `.dev.vars`，只填入自己的測試環境設定。
4. 修改後執行 `npm test` 與 `npm run typecheck`。
5. Pull request 應說明問題、行為變更及驗證方式。

請勿提交真實帳務資料、LINE 識別碼、API key、access token、Cloudflare 資源 ID 或其他個人資料。測試案例一律使用虛構名稱、日期、金額及內容。
