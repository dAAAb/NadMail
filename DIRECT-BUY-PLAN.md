# Direct Buy 方案 — AI Agent 自己買 .nad，NadMail 只做串接

## 核心想法
NadMail **不代買**，而是提供 NNS 註冊所需的簽名 + calldata，讓 AI agent **自己的錢包直接呼叫 NNS 合約**。

## 為什麼這比 Proxy Buy 好

| | Proxy Buy (V1) | Direct Buy (新方案) |
|---|---|---|
| 誰呼叫 NNS 合約 | Worker 錢包 | AI agent 自己的錢包 |
| msg.sender | Worker ❌ | Agent ✅ |
| 折扣 | 不可用 ❌ | 可用 ✅ |
| NFT 轉讓 | 需要額外步驟 | 不需要（直接是 owner）|
| Timeout 風險 | 高（Worker 做所有事）| 低（Agent 自己等確認）|
| 手續費 | 0%（改掉了）| 0% |
| NadMail 收入 | Referral 10% | Referral 10% ✅ 一樣 |
| 複雜度 | 高 | **低很多** |
| 安全性 | Worker 管大量 MON | Agent 自己管錢 ✅ |

## AI Agent 流程（4 calls + 1 on-chain tx）

```
# 1. 查價格 + 確認可用（不需 auth）
GET /api/register/nad-name-price/myname
→ { price_mon: 497, available_nns: true, available_nadmail: true }

# 2. 取得 NNS 註冊簽名 + calldata（不需 auth）
GET /api/register/nad-name-sign/myname?buyer=0xAgentWallet
→ { signature, nonce, deadline, discountKey, discountClaimProof, referrer, calldata, value }

# 3. Agent 自己發鏈上交易（用自己的錢包）
sendTransaction({
  to: NNS_REGISTRAR,   // 0xE18a7550...
  data: calldata,       // 從 step 2 拿到的
  value: value,         // 從 step 2 拿到的（含折扣）
  chainId: 143
})
→ 等確認 → Agent 現在擁有 myname.nad NFT ✅

# 4. 回 NadMail 註冊（帶 handle）
POST /api/auth/agent-register
{ address, signature, message, handle: "myname" }
→ { email: "myname@nadmail.ai", token_symbol: "MYNAME", token_address: "0x..." } 🎉
```

## 需要改的東西

### API 改動

#### `GET /api/register/nad-name-sign/:name` — 加 calldata 回傳

目前只回傳 signature/nonce/deadline。需要加上：
- `calldata`: 編碼好的 `registerWithSignature` calldata（Agent 直接用）
- `value`: 要付多少 MON（含折扣的 wei）
- `registrar`: NNS 合約地址
- `chain_id`: 143

```json
{
  "signature": "0x...",
  "nonce": "123...",
  "deadline": "1771...",
  "referrer": "0x7e0F...",
  "discountKey": "0x4461...",
  "discountClaimProof": "0x...",
  
  "calldata": "0x623f1166...",      // ← 新增：編碼好的完整 calldata
  "value": "256000000000000000000",  // ← 新增：要付的 MON (wei)
  "value_mon": 256,                  // ← 新增：人類可讀
  "registrar": "0xE18a7550AA35895c87A1069d1B775Fa275Bc93Fb",
  "chain_id": 143,
  
  "guide": {
    "step1": "Send transaction: { to: registrar, data: calldata, value: value, chainId: 143 }",
    "step2": "Wait for confirmation",
    "step3": "Call POST /api/auth/agent-register with { handle: 'myname' } to get your email + meme coin"
  }
}
```

#### Agent-register — 已有 NNS 驗證 ✅
已經會檢查 `getNadNamesForWallet`，確認 agent 擁有 .nad NFT。不需要改。

#### API Docs — 更新 quick_start
加一段「Buy .nad name via API」的說明。

### 前端改動
無。Dashboard 流程已經是 direct buy（MetaMask）。

### 可以刪除的東西
Proxy buy 端點可以標記為 deprecated：
- `POST /api/register/buy-nad-name/quote` → deprecated
- `POST /api/register/buy-nad-name` → deprecated
- `GET /api/register/buy-nad-name/status/:id` → deprecated

保留但不推薦，給沒有鏈上交易能力的 agent 用。

---

## 對 AI Agent 開發者的體驗

### Before (Proxy Buy)
```
查價 → 取報價 → 轉帳到 deposit → 呼叫 buy API → 等 Worker 處理 → 可能 timeout → 手動補完
7 步，不可靠
```

### After (Direct Buy)
```
查價 → 取簽名+calldata → 自己發 TX → 回 NadMail 註冊
4 步，可靠，自主掌控
```

### Agent 端程式碼範例

```javascript
const { ethers } = require('ethers');

async function getMyNadMail(name, wallet, provider) {
  // 1. Check price
  const price = await fetch(`https://api.nadmail.ai/api/register/nad-name-price/${name}`);
  const priceData = await price.json();
  if (!priceData.available_nns) throw new Error('Name not available');
  
  // 2. Get NNS registration signature + calldata
  const sign = await fetch(`https://api.nadmail.ai/api/register/nad-name-sign/${name}?buyer=${wallet.address}`);
  const signData = await sign.json();
  
  // 3. Send transaction (agent pays directly)
  const tx = await wallet.sendTransaction({
    to: signData.registrar,
    data: signData.calldata,
    value: BigInt(signData.value),
    chainId: 143,
  });
  await tx.wait();
  console.log(`${name}.nad registered! TX: ${tx.hash}`);
  
  // 4. Register on NadMail
  const siwe = await fetch('https://api.nadmail.ai/api/auth/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address })
  });
  const { message } = await siwe.json();
  const signature = await wallet.signMessage(message);
  
  const reg = await fetch('https://api.nadmail.ai/api/auth/agent-register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address, signature, message, handle: name })
  });
  const result = await reg.json();
  console.log(`Email: ${result.email}`);
  console.log(`Token: $${result.token_symbol}`);
  
  return result;
}
```

---

## NadMail 收入

完全不變：
- NNS referral commission 10%（diplomat.nad 自動收）
- 不需要管用戶的錢
- 不需要 Worker 代買
- 不需要 deposit address

---

## 預估工時

| 項目 | 時間 |
|---|---|
| nad-name-sign 加 calldata + value | 1h |
| API docs 更新 | 0.5h |
| 測試 | 1h |
| Agent 範例程式碼 | 0.5h |
| **Total** | **~3h** |

比 Proxy Buy V2 (8h) 少很多，而且更可靠。

---

## 建議

**優先做 Direct Buy，Proxy Buy V2 暫緩。**

Direct Buy 解決了所有核心問題（msg.sender、timeout、折扣、安全性），
而且改動量小（主要是 nad-name-sign 加 calldata 回傳）。

Proxy Buy 保留作為 fallback，給完全沒有鏈上交易能力的 agent 用
（例如沒有 private key 只有 API access 的 agent）。

FK migration (handle→wallet) 仍然建議做，因為影響的不只是 proxy buy。
