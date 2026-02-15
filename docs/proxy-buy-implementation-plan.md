# NadMail Proxy-Buy 實作計畫

> 日期: 2026-02-15
> 狀態: 規劃中

---

## 1. 用戶體驗流程

### 1.1 查詢與導購

```
用戶輸入 handle → Check Availability
    ↓
┌─ Available ──────────────────────────────────────┐
│                                                   │
│  ✅ cloudlobster@nadmail.ai is available!         │
│                                                   │
│  .nad Name Price:                                 │
│  ┌────────────────────────────────────────┐      │
│  │ Registration fee:     ~~512 MON~~      │      │
│  │ Discount (Xmas Gift): -50%             │      │
│  │ Final price:          256 MON (~$6)    │      │
│  │ Service fee (15%):    +38.4 MON        │      │
│  │ ─────────────────────────────────      │      │
│  │ Total:                294.4 MON        │      │
│  └────────────────────────────────────────┘      │
│                                                   │
│  [🛒 Buy via NadMail (294.4 MON)]  ← proxy-buy  │
│  [🔗 Buy on nad.domains ↗]         ← referral   │
│                                                   │
│  💡 Already have cloudlobster.nad?               │
│     [Claim Now — Free]                            │
│                                                   │
└───────────────────────────────────────────────────┘
```

### 1.2 購買路線

**路線 A: Referral 導購（簡單）**
1. 點擊「Buy on nad.domains」
2. 帶 diplomat.nad 的 referral code 導向 nad.domains
3. 用戶自行完成購買
4. 購買後回到 NadMail 開設帳號
5. NadMail 獲得 10% referral 佣金

**路線 B: Proxy-Buy（一站式）**
1. 點擊「Buy via NadMail」
2. 連結錢包 / 檢查餘額
3. 用戶發送 MON 到 NadMail 存款地址
4. NadMail 後端執行購買 + 轉移 .nad 到用戶
5. NadMail 收取 15% 服務費
6. 自動進入開設 email + 發幣流程

### 1.3 餘額檢查

```
錢包已連結
    ↓
檢查 MON 餘額
    ├─ 足夠 → 直接購買
    ├─ 不足但有 ETH/Base → 提示：
    │   "You have 0.5 ETH on Base. Bridge to Monad?"
    │   [Bridge via Orbiter ↗] [Bridge via Relay ↗]
    └─ 無餘額 → 提示：
        "You need MON to purchase. Buy MON on:"
        [Binance ↗] [OKX ↗] [Bridge from ETH ↗]
```

---

## 2. 技術架構

### 2.1 後端 API

#### GET `/api/register/nad-name-price/:name` (已有，需更新)

**Request:**
```
GET /api/register/nad-name-price/cloudlobster
```

**Response (更新版):**
```json
{
  "name": "cloudlobster",
  "nad_name": "cloudlobster.nad",
  "available_nns": true,
  "available_nadmail": true,
  
  "pricing": {
    "base_price_mon": 512,
    "base_price_wei": "512000000000000000000",
    "discounts": [
      {
        "key": "DayOneMainnet",
        "description": "Xmas Gift",
        "percent": 50,
        "eligible": null
      }
    ],
    "best_discount_percent": 50,
    "discounted_price_mon": 256,
    "source": "contract"
  },
  
  "proxy_buy": {
    "available": true,
    "service_fee_percent": 15,
    "total_mon": 294.4,
    "total_wei": "294400000000000000000",
    "deposit_address": "0x4BbdB896eCEd7d202AD7933cEB220F7f39d0a9Fe",
    "method": "POST /api/register/buy-nad-name/quote"
  },
  
  "referral": {
    "url": "https://app.nad.domains?rc=VQp3ICKPVsZ4WCAsWiN4XDV5ZslfXCNiVvIOHsIuXCDiAMAOZil0WMR0",
    "commission_percent": 10,
    "referrer": "diplomat.nad"
  },
  
  "nadcard_url": "https://api.nad.domains/nadcard/cloudlobster.nad"
}
```

#### POST `/api/register/buy-nad-name/quote` (已有，需更新)

**Request:**
```json
{
  "name": "cloudlobster",
  "buyer_address": "0x..."
}
```

**Response:**
```json
{
  "name": "cloudlobster",
  "deposit_address": "0x4BbdB896eCEd7d202AD7933cEB220F7f39d0a9Fe",
  "amount_mon": 294.4,
  "amount_wei": "294400000000000000000",
  "breakdown": {
    "nns_price": 256,
    "service_fee": 38.4,
    "service_fee_percent": 15
  },
  "expires_at": "2026-02-15T16:00:00Z",
  "quote_id": "q_abc123"
}
```

#### POST `/api/register/buy-nad-name` (已有，需更新)

**Request:**
```json
{
  "name": "cloudlobster",
  "tx_hash": "0x...",
  "quote_id": "q_abc123",
  "buyer_address": "0x..."
}
```

**Flow:**
1. 驗證 tx_hash（確認金額正確、已確認）
2. 執行 NNS 購買（使用 NadMail 錢包）
3. 轉移 .nad 到 buyer_address
4. 服務費留在 NadMail 錢包（之後轉到 diplomat.nad）
5. 自動開設 NadMail 帳號 + 發行 token

#### GET `/api/register/balance/:address` (新增)

**Response:**
```json
{
  "address": "0x...",
  "balances": {
    "monad": { "balance_mon": 765.5, "sufficient": true },
    "ethereum": { "balance_eth": 0.5, "bridge_options": ["orbiter", "relay"] },
    "base": { "balance_eth": 0.1, "bridge_options": ["orbiter"] }
  },
  "required_mon": 294.4
}
```

### 2.2 前端更新 (Landing.tsx)

```
需要更新的元件：
├── PriceDisplay        ← 價格顯示（含折扣）
├── ProxyBuyButton      ← 一站式購買按鈕
├── ReferralButton      ← 導購按鈕
├── BalanceChecker      ← 錢包餘額檢查
├── BridgeHelper        ← 跨鏈提示
└── PurchaseFlow        ← 購買流程（quote → pay → confirm）
```

### 2.3 合約互動

```
Price Query:
├── PriceOracleV2.getRegisteringPriceInToken(name, 0x0)
│   → base price (512 MON)
├── Registrar.getActiveDiscounts()
│   → discount list (18 active)
└── DiscountVerifier.isEligibleForDiscount(buyer, proof)
    → eligible? (需要 Merkle proof)

Purchase:
├── Registrar.registerWithSignature(RegisterData, signature)
│   RegisterData = {
│     name, nameOwner, setAsPrimaryName,
│     referrer, discountKey, discountClaimProof,
│     nonce, deadline, attributes, paymentToken
│   }
│   ⚠️ 需要 NNS 後端簽名！
└── NNS.transferFrom(from, to, tokenId)
    → 轉移 .nad 到買家
```

---

## 3. 關鍵問題 & 待研究

### 3.1 ✅ registerWithSignature 的 signature（已解決！）

**API Endpoint:**
```
GET https://api.nad.domains/v3/register/signature?data=<encoded>
```

**編碼方式:** JSON → Base64 → Caesar Cipher (shift -19)
**解碼方式:** Caesar Cipher (shift +19) → Base64 → JSON

**Request Data:**
```json
{
  "name": "testlobster999",
  "nameOwner": "0x94c72f43...",
  "setAsPrimaryName": true,
  "referrer": "0x0000...",
  "discountKey": "0x0000...",
  "discountClaimProof": "0x",
  "attributes": [],
  "paymentToken": "0x0000...",
  "chainId": "143"
}
```

**Response (解碼後):**
```json
{
  "signature": "0x7b11c926...",
  "nonce": "88029487...",
  "deadline": "1771171254"
}
```

**注意:** 不需要 cookie 或認證！公開 API！

### 3.2 ✅ 折扣的 Merkle Proof（已解決！）

**API Endpoint:**
```
GET https://api.nad.domains/discount-proofs?claimer=<address>&chainId=143&name=<name>
```

**Response:**
```json
{
  "proofs": [
    {
      "discountKey": "DayOneMainnet",
      "validationData": "0x00000000...（Merkle proof）"
    }
  ]
}
```

**注意:**
- 公開 API，不需要認證！
- Cloud Lobster 錢包有 DayOneMainnet (Xmas Gift 50%) 資格
- validationData 直接包含完整的 Merkle proof
- Proxy-buy 時可以用買家的地址查詢折扣

### 3.3 🟡 Referral Code 格式

已知：
- rc 參數是 base64 編碼
- 前 20 bytes 是 referrer 地址
- 後 22 bytes 用途不明

- [ ] 需要連結錢包後在 nad.domains 生成 referral code
- [ ] 確認 diplomat.nad 的 referral code 是否長期有效

### 3.4 🟡 服務費參數化

```toml
# wrangler.toml
[vars]
SERVICE_FEE_PERCENT = "15"
FEE_RECIPIENT = "0x7e0F24854c7189C9B709132fEb6e953D4EC74424"  # diplomat.nad
```

### 3.5 🟢 餘額檢查

- Monad: 直接 RPC `eth_getBalance`
- ETH/Base: 需要多鏈 RPC（可用 Alchemy/Infura）
- 或者前端用 wagmi 讀取

---

## 4. 實作順序

### Phase 1: 價格顯示 + 導購（最快上線）
1. [x] 修復 price API（RPC 問題）
2. [ ] 更新 price API — 加入 `getActiveDiscounts()` 折扣列表
3. [ ] 更新 price API — 加入 diplomat.nad referral URL
4. [ ] 更新前端 — 顯示價格（原價劃掉 + 折扣 + 最終價格）
5. [ ] 更新前端 — 加入「Buy on nad.domains」referral 按鈕
6. [ ] 測試 diplomat.nad referral 連結是否有效

### Phase 2: Proxy-Buy 核心
7. [ ] 研究 registerWithSignature 的 signature 來源
8. [ ] 研究 Merkle proof 取得方式
9. [ ] 實作 quote API（含服務費計算）
10. [ ] 實作 buy API（執行購買 + 轉移）
11. [ ] 服務費自動轉帳到 diplomat.nad

### Phase 3: 餘額 & 跨鏈
12. [ ] 實作 balance API
13. [ ] 前端錢包連結 + 餘額顯示
14. [ ] 跨鏈 bridge 提示

### Phase 4: AI API
15. [ ] AI-friendly API（簡化版，一個 endpoint 完成所有）
16. [ ] 文件 + 範例

---

## 5. 合約地址

| 名稱 | 地址 |
|------|------|
| NNS Registrar | `0xE18a7550AA35895c87A1069d1B775Fa275Bc93Fb` |
| PriceOracleV2 | `0xdF0e18bb6d8c5385d285C3c67919E99c0dce020d` |
| NadMail Wallet | `0x4BbdB896eCEd7d202AD7933cEB220F7f39d0a9Fe` |
| Diplomat.nad | `0x7e0F24854c7189C9B709132fEb6e953D4EC74424` |
| Cloud Lobster | `0x94c72f43F9F2E04Bcf1545021725353DC177f7E6` |

## 6. Referral 資訊

| 項目 | 值 |
|------|-----|
| Referrer | diplomat.nad |
| Referral URL | `https://app.nad.domains?rc=VQp3ICKPVsZ4WCAsWiN4XDV5ZslfXCNiVvIOHsIuXCDiAMAOZil0WMR0` |
| Commission | 10% |
