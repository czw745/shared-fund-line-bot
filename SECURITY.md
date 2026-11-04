# Security Policy

## 回報安全問題

請透過 GitHub Security Advisory 私下回報安全問題，不要建立公開 issue，也不要附上真實帳務資料、憑證或完整 webhook payload。

## 部署責任

本專案供自行部署。每個部署者應使用自己的 Cloudflare、LINE 與 Gemini 帳戶，並以 Wrangler secrets 或 GitHub Actions secrets 保存憑證。不要將 `.dev.vars`、`wrangler.toml` 或匯出的 D1 資料提交至版本控制。

若任何憑證曾出現在公開 commit、issue、CI log 或附件中，應立即撤銷並重新建立；只從 Git 歷史刪除不足以解除風險。
