# Proxy Buy V2 — AI Agent 一條龍購買方案

## 目標
讓 AI agent 用 **3 個 API call** 完成：查價 → 付款 → 拿到 name@nadmail.ai + $TOKEN

## 目前問題

### 1. Worker 30 秒 Timeout
買 .nad name 需要：NNS 簽名 → 鏈上購買 → 等確認 → 轉 NFT → 等確認 → 建 token → 等確認
6+ 個鏈上操作，遠超 Cloudflare Worker 30 秒限制。

### 2. NNS 要求 msg.sender == nameOwner
Worker 代買必須先買給自己再轉 NFT — 多一步鏈上交易。

### 3. D1 FK 用 handle 當 PK
handle 升級時子表 FK 會擋。有 email/credit 記錄的帳號 upgrade 必定失敗。

### 4. 折扣不可用
NNS 折扣驗證綁 msg.sender，proxy mode 下 Worker 不是折扣對象。

---

## V2 設計：異步訂單系統

### 用戶流程（3 calls）

```
# 1. 查價（不需 auth）
GET /api/register/nad-name-price/myname
→ { price_mon: 497, proxy_buy: { total_mon: 497, deposit_address: "0x4Bbd..." } }

# 2. 付款 + 下單（需 auth）
POST /api/register/buy-nad-name
{ name: "myname", tx_hash: "0x..." }
→ { order_id: "pp-xxx", status: "processing", poll_url: "/api/register/buy-nad-name/status/pp-xxx" }

# 3. 輪詢狀態（每 10 秒查一次）
GET /api/register/buy-nad-name/status/pp-xxx
→ { status: "completed", email: "myname@nadmail.ai", token_symbol: "MYNAME", ... }
```

### 後台處理（Cron Worker）

```
每 30 秒執行一次：
1. 撈出 status = 'paid' 的 orders
2. 對每個 order：
   a. 取得 NNS 簽名（Worker 為 nameOwner）
   b. 呼叫 registerWithSignature（Worker 付 MON）
   c. 等鏈上確認
   d. 轉 NFT 給用戶錢包
   e. 等鏈上確認
   f. DB: 更新 handle + 建 meme coin
   g. 更新 order status = 'completed'
3. 失敗的 order → status = 'failed' + error_message
```

### 狀態機

```
pending → paid → processing → nns_registered → nft_transferred → upgrading → completed
                     ↓              ↓                ↓               ↓
                   failed        failed           failed          failed
```

每個步驟都記錄進度，失敗可以從斷點恢復（不需要重頭來）。

---

## DB Schema 改動

### 1. FK 遷移：handle → wallet

```sql
-- 新增 wallet 欄位到子表
ALTER TABLE emails ADD COLUMN wallet TEXT;
ALTER TABLE daily_email_counts ADD COLUMN wallet TEXT;
ALTER TABLE credit_transactions ADD COLUMN wallet_ref TEXT;
ALTER TABLE daily_emobuy_totals ADD COLUMN wallet TEXT;

-- 回填 wallet
UPDATE emails SET wallet = (SELECT wallet FROM accounts WHERE accounts.handle = emails.handle);
-- ... 其他表同理

-- 之後新 FK 改引用 wallet，移除 handle FK
-- 注意：SQLite 不支持 DROP CONSTRAINT，需要重建表
```

### 2. proxy_purchases 加欄位

```sql
ALTER TABLE proxy_purchases ADD COLUMN step TEXT DEFAULT 'paid';
-- step values: paid, nns_signing, nns_registered, nft_transferring, nft_transferred, upgrading, token_creating, completed
ALTER TABLE proxy_purchases ADD COLUMN nns_tx TEXT;
ALTER TABLE proxy_purchases ADD COLUMN nft_transfer_tx TEXT;
ALTER TABLE proxy_purchases ADD COLUMN token_create_tx TEXT;
ALTER TABLE proxy_purchases ADD COLUMN retries INTEGER DEFAULT 0;
ALTER TABLE proxy_purchases ADD COLUMN last_attempt INTEGER;
```

---

## Cron 設計

### wrangler.toml
```toml
[triggers]
crons = ["*/30 * * * *"]  # 已有 — diplomat agent
# 加第二個 cron 或在同一個 handler 裡處理 proxy purchases
```

### 實作

```typescript
// worker/src/proxy-cron.ts
export async function processProxyPurchases(env: Env) {
  const orders = await env.DB.prepare(
    "SELECT * FROM proxy_purchases WHERE status = 'paid' OR (status = 'processing' AND step != 'completed') ORDER BY created_at LIMIT 5"
  ).all();

  for (const order of orders.results) {
    try {
      await processOrder(order, env);
    } catch (e) {
      await env.DB.prepare(
        "UPDATE proxy_purchases SET retries = retries + 1, error_message = ?, last_attempt = ? WHERE id = ?"
      ).bind(e.message, Date.now() / 1000, order.id).run();
      
      // 超過 3 次重試 → 標記失敗
      if (order.retries >= 3) {
        await env.DB.prepare(
          "UPDATE proxy_purchases SET status = 'failed' WHERE id = ?"
        ).bind(order.id).run();
      }
    }
  }
}

async function processOrder(order, env) {
  // 根據 step 決定從哪裡繼續
  switch (order.step) {
    case 'paid':
      // Step 1: NNS 註冊
      const regTx = await registerOnNns(order.name, env);
      await updateStep(order.id, 'nns_registered', { nns_tx: regTx });
      // fall through

    case 'nns_registered':
      // Step 2: 轉 NFT
      const nftTx = await transferNft(order.name, order.wallet, env);
      await updateStep(order.id, 'nft_transferred', { nft_transfer_tx: nftTx });
      // fall through

    case 'nft_transferred':
      // Step 3: 升級 handle + 建 token
      await upgradeHandle(order.name, order.wallet, env);
      await updateStep(order.id, 'completed');
  }
}
```

---

## 前端 / API 影響

### Landing.tsx
- 紫色按鈕文字改為 `Register myname.nad — 497 MON`（移除 fee）
- 已完成 ✅

### API docs (/api/docs)
- buy-nad-name response 加 `poll_url`
- 加 status polling 說明

### Dashboard
- 不受影響（直接走 MetaMask）

---

## 優先實作順序

1. **FK 遷移 handle → wallet**（最高優先 — 影響所有 upgrade 操作）
2. **proxy_purchases 加 step 欄位**
3. **Cron 處理器**（在現有 diplomat cron 裡加一個 processProxyPurchases 呼叫）
4. **buy-nad-name 改為立即返回** order_id + poll
5. **Status polling 端點改進**（加 step 顯示）
6. **壓力測試**

---

## 預估工時

| 項目 | 時間 |
|---|---|
| FK migration | 2-3h |
| Cron processor | 2h |
| API 改 async | 1h |
| 測試 + 修 bug | 2h |
| **Total** | **~8h** |
