# .nad Name 轉移時的 NadMail 帳號處理方案

## 場景

A 擁有 `alice.nad` 並在 NadMail 上註冊了 `alice@nadmail.ai`。
A 把 `alice.nad` NFT 轉售/轉移給 B。
NadMail 該如何處理？

---

## 建議方案：Webhook 監聽 + 自動降級 + 新 Owner 優先認領

### 1. 監聽 NNS NFT Transfer 事件

```
on NNS Transfer(from=A, to=B, tokenId=alice):
  1. 在 NadMail DB 標記 alice 帳號為 "ownership_changed"
  2. A 的 handle 降級為 0x 地址（延遲 72 小時，給 A 緩衝期）
  3. 釋放 alice@nadmail.ai handle 為 "reserved_for_nns_owner"（只有 B 能 claim）
```

### 2. 對舊 Owner A 的處理

| 項目 | 處理 |
|---|---|
| Email 帳號 | 降級為 `0xAaaa...@nadmail.ai`（72h 後自動執行）|
| 舊 Email | 保留在帳號裡（搬到新 handle 下）|
| Meme Coin $ALICE | **不動** — token 是鏈上的，跟 NadMail handle 無關 |
| Credits | 保留在帳號裡 |
| Pro 會員 | 保留 |

### 3. 對新 Owner B 的處理

| 項目 | 處理 |
|---|---|
| 來 NadMail 時 | 系統偵測到 B 擁有 alice.nad → 提示 claim |
| Claim 流程 | SIWE 認證 → 鏈上驗證 NFT → 綁定 handle |
| Email | 拿到 `alice@nadmail.ai` |
| Meme Coin | **建新的 $ALICE token**（因為舊的是 A 的資產）|
| 舊 Email | B 看不到 A 的歷史郵件（隱私保護）|

### 4. 72 小時緩衝期

為什麼要 72h？
- A 可能只是在錢包間轉移 NFT（不是真的賣掉）
- 給 A 時間把重要 email forward 出去
- 避免即時降級造成的服務中斷

緩衝期內：
- A 仍然可以用 alice@nadmail.ai 收發信
- B 還不能 claim
- A 收到通知：「你的 alice.nad 已轉移，72h 後 handle 將被釋放」

### 5. Meme Coin 處理（重要）

**舊 Token 歸舊 Owner：**
- A 建立的 $ALICE token 是鏈上資產，不能也不應該被轉移
- Token 持有者（包括收信時自動買的）不受影響
- Token 會繼續在 nad.fun 上交易

**新 Token 歸新 Owner：**
- B claim alice@nadmail.ai 時，系統建立新的 $ALICE token
- 但如果舊 $ALICE 還在 nad.fun 上…同名 token 會衝突嗎？
  
**解法選項：**
| 選項 | 描述 | 推薦 |
|---|---|---|
| A: 同名覆蓋 | 新 $ALICE 取代舊的在 NadMail 的引用 | ❌ 複雜 |
| B: 新名稱 | 新 token 叫 $ALICE2 或 $ALICE_V2 | ❌ 醜 |
| C: 不建新幣 | B 不拿到新 meme coin，只有 email | 🟡 簡單 |
| D: 沿用舊幣 | B 繼承 A 的 $ALICE token（DB 指向同一個地址）| ✅ 推薦 |

**推薦 Option D：** B 繼承 A 的 token。理由：
- $ALICE 的價值來自 alice@nadmail.ai 這個 email 的使用量
- 如果 B 現在擁有 alice@nadmail.ai，新的 email 活動應該繼續推動 $ALICE
- 對 token 持有者最公平
- 實作最簡單（DB 裡的 token_address 不變）

但要注意：A 持有的 50% 初始 token 不會被追回。B 不會拿到初始分配。

---

## 實作方式

### 方式 A：Event Listener（推薦）

在 Worker 的 cron 裡定期掃描：
```
每 30 分鐘：
1. 查所有有 .nad name 的帳號
2. 對每個帳號，驗證鏈上 NFT ownership
3. 如果 owner 變了 → 觸發 ownership_changed 流程
```

### 方式 B：Lazy Check（簡單）

在用戶操作時才檢查：
- 登入時：驗證 .nad name 還是不是自己的
- 發信時：驗證 handle 對應的 .nad name 還在
- 如果不在 → 即時降級

### 推薦：方式 B（Lazy Check）

理由：
- 不需要額外的 cron 資源
- 在用戶實際使用時才觸發，不會有無謂的查詢
- 實作簡單，加幾行 middleware 就好

---

## 實作優先順序

1. **Phase 1（快）：** 在 auth/send middleware 加 .nad ownership check
2. **Phase 2（中）：** 自動降級 + 通知舊 owner
3. **Phase 3（慢）：** 新 owner claim 流程（其實已有 — agent-register + upgrade-handle）

---

## API 變更

### auth middleware 加 ownership check
```typescript
// 在 authMiddleware 中加：
if (account.nad_name) {
  const stillOwns = await checkNadOwnership(account.wallet, account.handle);
  if (!stillOwns) {
    // 降級 handle
    await downgradeToWalletHandle(account);
    // 回傳新的 JWT
  }
}
```

### 新端點（可選）
```
POST /api/register/release-handle
// 用戶主動釋放 handle（不等自動偵測）
```

---

## 總結

| 事件 | 處理 |
|---|---|
| A 轉移 NFT 給 B | A 的 handle 在下次使用時自動降級 |
| A 的舊 email | 保留在 A 的帳號（新 0x handle）|
| A 的 $ALICE token | 不動（鏈上資產）|
| B 來 NadMail | B 可以 claim alice@nadmail.ai |
| B 的 meme coin | 繼承 A 的 $ALICE（推薦）|
| B 的舊 email | 看不到 A 的（隱私保護）|
