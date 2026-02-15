# NNS 折扣與 Referral 機制研究

> 研究日期: 2026-02-15
> 研究者: Cloud Lobster 🦞

## 概述

NNS (Nad Name Service) 的定價由三部分組成：
1. **PriceOracleV2** - 基礎價格查詢
2. **Discount 系統** - 基於身份驗證的折扣
3. **Referral 系統** - 推薦獎勵

---

## 1. 價格查詢

### 合約地址
- **PriceOracleV2**: `0xdF0e18bb6d8c5385d285C3c67919E99c0dce020d`
- **NNS Registrar**: `0xE18a7550AA35895c87A1069d1B775Fa275Bc93Fb`

### 價格函數
```solidity
function getRegisteringPriceInToken(
    string memory name,
    address token  // 0x0 = MON
) view returns (uint256 base, address tokenAddr, uint8 decimals)
```

### 價格範圍（MON，無折扣）
| 名稱長度 | 價格 |
|----------|------|
| 3 字元 | ~5,694 MON |
| 4 字元 | ~1,726 MON |
| 5+ 字元 | ~512-691 MON |

---

## 2. 折扣機制

### 合約函數
```solidity
// 取得所有活躍折扣
function getActiveDiscounts() view returns (DiscountDetails[] memory)

struct DiscountDetails {
    bool active;
    address discountVerifier;  // 驗證合約
    bytes32 key;               // 折扣類型
    uint256 discountPercent;   // 折扣百分比
    string description;        // 描述
}
```

### 目前活躍折扣（共 18 個）

| # | Key | 描述 | 折扣 | Verifier |
|---|-----|------|------|----------|
| 0 | Keone-1K-Discount-Key | Keone 1K Nads | 50% | 0x3a89...eBc4 |
| 1 | Freemint | Freemint | 100% | 0x50D6...A54E |
| 2 | RealNadsFreemint | RealNads Freemint | 100% | 0x50D6...A54E |
| 3 | Starlist | NNS Starlist | 50% | 0x3a89...eBc4 |
| 4 | TheDaksHolders | The Daks testnet holder | 20% | 0xD11F...88a0 |
| 5 | LlamaoChill Night | Llamao chill night prize | 20% | 0xD11F...88a0 |
| 6 | OvernadsHolder | Overnads holder | 20% | 0xD11F...88a0 |
| 7 | BobrHolder | Bobr holder | 20% | 0xD11F...88a0 |
| 8 | Nadlist | NNS Nadlist | 20% | 0xD11F...88a0 |
| 9 | BeannadHolders | Beannad SBT holders | 50% | 0x6906...9339 |
| 10 | ChogTokenHolders | $CHOG holders | 30% | 0x2288...8748 |
| 11 | RealNadsHolders | RealNads holders | 50% | 0x3A72...8208 |
| 12 | GmonadTokenHolders | $GMONAD holders | 30% | 0x5b57...a8F8 |
| 13 | LlamaoHolders | Llamao holders | 50% | 0x5a58...83Bd |
| 14 | EmonadTokenHolders | $emo holders | 30% | 0x3610...F3fF |
| 15 | HaHaWalletUsers | HaHa Wallet user | 50% | 0x3a89...eBc4 |
| 16 | ShrampTokenHolders | $shramp holders | 30% | 0x51CA...075F |
| 17 | DayOneMainnet | Xmas Gift | 50% | 0x3a89...eBc4 |

### 折扣驗證
```solidity
// 每個 verifier 合約實現此接口
function isEligibleForDiscount(
    address claimer,
    bytes calldata claimProof
) returns (bool)
```

### 折扣分類

**Merkle Proof 類（verifier: 0x3a89...eBc4）**:
- Keone 1K Nads (50%)
- NNS Starlist (50%)
- HaHa Wallet Users (50%)
- DayOneMainnet / Xmas Gift (50%)
- 需要提供 Merkle proof 作為 `claimProof`

**NFT/Token Holder 類（verifier: 0xD11F...88a0 等）**:
- 各種 NFT 和 token holders
- `claimProof` 可能為空（直接檢查鏈上餘額）

**特殊類（verifier: 0x50D6...A54E）**:
- Freemint / RealNads Freemint (100%)

---

## 3. Referral 機制

### 前端實現
```javascript
// referral code 存儲在 sessionStorage
const key = "nns_referral_code";
sessionStorage.setItem(key, rc);
sessionStorage.getItem(key);
```

### Referral URL 格式
```
https://app.nad.domains?rc=<base64_encoded_data>
```

### Referral Code 結構
- 前 20 bytes: referrer 錢包地址
- 後 22 bytes: 附加資料（可能是簽名或其他驗證資料）

### Referral 獎勵
- 10% 的購買金額轉到 referrer 錢包
- 連結錢包後自動產生 referral 連結

---

## 4. 註冊函數

### registerWithSignature
```solidity
function registerWithSignature(
    RegisterData calldata params,
    bytes calldata signature
) payable

struct RegisterData {
    string name;
    address nameOwner;
    bool setAsPrimaryName;
    address referrer;
    bytes32 discountKey;
    bytes discountClaimProof;
    uint256 nonce;
    uint256 deadline;
    Attribute[] attributes;
    address paymentToken;  // 0x0 = MON
}
```

### 流程
1. 用戶在前端輸入名稱
2. 前端檢查 `getActiveDiscounts()` 並驗證用戶是否符合折扣資格
3. 前端呼叫後端 API 取得 `signature`（包含 nonce 和 deadline）
4. 用戶發送交易 `registerWithSignature(params, signature)`
5. 合約驗證簽名、折扣資格、扣款

---

## 5. 其他功能

### NadCard
```
https://api.nad.domains/nadcard/<name>.nad
```
- 顯示大頭貼和 .nad 名稱
- OG Image: `https://api.nad.domains/og-image?name=<name>.nad`

### Profile Records
- 設定頁面: `https://app.nad.domains/profile?name=<name>.nad&tab=records`
- 可設定大頭貼、個資等

---

## 6. NadMail 整合建議

### 價格顯示
1. 呼叫 `getRegisteringPriceInToken()` 取得基礎價格
2. 呼叫 `getActiveDiscounts()` 取得折扣列表
3. 前端顯示可能的折扣範圍

### Proxy-Buy 流程
1. 用戶在 NadMail 輸入名稱
2. 後端查詢價格 + 折扣
3. 提供 referral 連結到 nad.domains（含 NadMail 的 referral code）
4. 或使用 proxy-buy（需要取得 signature）

### Referral 收入
- NadMail 可以生成自己的 referral code
- 每筆購買獲得 10% referral 獎勵
- 這是除了 15% service fee 之外的額外收入

### 注意事項
- `registerWithSignature` 需要後端簽名（可能是 NNS 官方 API）
- 折扣驗證需要 Merkle proof 或鏈上餘額檢查
- Referral code 格式需要進一步逆向工程
