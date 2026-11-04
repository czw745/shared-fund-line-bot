# LINE 記錄者名稱規格

## 目標

每筆帳務紀錄都能看出是哪位授權成員建立，同時避免每次查詢都重複呼叫 LINE API。

## 行為

- 收到授權成員的文字或按鈕事件時，若尚未快取名稱，呼叫 LINE 群組成員 Profile API。
- 若 `MEMBER_NAME_OVERRIDES` 有指定名稱，固定覆寫快取並優先於 LINE Profile；對照以 Cloudflare Secret 保存，不寫入 Git。
- 以 LINE User ID 作為穩定識別，`displayName` 只作為顯示用快取。
- 最近紀錄、本月明細、修改清單與修改前預覽顯示 `記錄者：名稱`。
- Profile API 失敗不得阻止記帳；顯示名稱暫時使用 `成員`，之後事件可再次取得。
- 舊 D1 狀態沒有名稱欄位時自動補上空物件，不需要 migration。

## 驗收

- 同一位成員只需成功查詢一次 Profile，後續使用快取。
- 兩位成員的交易顯示各自名稱。
- Profile API 失敗時交易仍能入帳。
- 完整測試與型別檢查通過。
