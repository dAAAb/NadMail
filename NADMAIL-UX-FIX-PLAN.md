# NadMail UX 修復優化計畫

## 問題背景

Manus agent 使用 NadMail 時遇到以下狀況：
1. 成功註冊 `manusclaw@nadmail.ai` 帳號
2. DB 顯示 `nad_name: manusclaw.nad`，但**鏈上並未真正購買**
3. Manus 自己也不確定 .nad 有沒有買到
4. NadMail API 回傳的資訊讓 agent 誤以為一切都已完成

### 根本原因

NadMail 的 `agent-register` 在使用者帶 `handle` 參數時：
- 直接設定 `nadName = \`${handle}.nad\`` （auth.ts:195）
- **只做 NNS 可用性檢查**（確認沒被別人佔）
- **不會自動購買 .nad**（沒有 auto-buy 機制）
- DB 寫入 `nad_name` 欄位，但這只是「期望值」，不是鏈上事實

對比 BaseMail：
- `agent-register` 帶 `basename` → 直接 on-chain `ownerOf` 驗證
- `auto_basename: true` → worker 代買，鏈上確認後才寫 DB
- 每一步都有 on-chain verification

## 修復計畫

### Phase 1: 誠實回報狀態（最優先）

**問題**：DB 的 `nad_name` 欄位在未購買時就寫入，造成 API 回傳誤導。

**修復**：

1. **`agent-register` — 區分 claimed vs owned**
   - 帶 `handle` 註冊但沒有走 free pool 也沒有鏈上 NFT → `nad_name` 設 null
   - response 加 `nad_name_status: "not_purchased"` 
   - 加 `purchase_hint` 引導購買

   ```typescript
   // auth.ts:195 附近
   // 舊：nadName = `${handle}.nad`; （不管有沒有鏈上）
   // 新：
   const ownedNames = await getNadNamesForWallet(wallet, rpcUrl);
   const ownsNad = ownedNames.some(n => n.toLowerCase() === handle);
   nadName = ownsNad ? `${handle}.nad` : null;
   ```

2. **Response 加購買引導**
   ```json
   {
     "handle": "manusclaw",
     "email": "manusclaw@nadmail.ai",
     "nad_name": null,
     "nad_name_status": "not_purchased",
     "purchase_hint": {
       "message": "Your handle is reserved! Purchase manusclaw.nad to own it on-chain.",
       "options": [
         {
           "action": "proxy_buy",
           "method": "POST /api/register/buy-nad-name",
           "description": "We buy it for you (send MON to cover cost)"
         },
         {
           "action": "buy_direct",
           "url": "https://app.nad.domains/",
           "description": "Buy directly on NNS, then call POST /api/register/upgrade-handle"
         }
       ]
     }
   }
   ```

3. **`/api/register/check/:input` — 加鏈上驗證**
   ```typescript
   // 現在回 nad_name: "manusclaw.nad" 但沒驗鏈上
   // 改：加 nad_name_verified: boolean（鏈上 ownerOf 確認）
   ```

### Phase 2: Auto-buy 流程（像 BaseMail 一樣一條龍）

**目標**：`agent-register` 支援 `auto_nad: true`，自動代買 .nad

1. **新參數** `auto_nad: boolean` + `nad_name: string`
2. **流程**：
   - 確認 name 可用（NNS `isNameAvailable`）
   - Worker 用 `WALLET_PRIVATE_KEY` 代買（已有 `buy-nad-name` 邏輯）
   - 等 tx confirm → 轉移 NFT 給用戶
   - 寫 DB + 回傳

3. **費用來源**：
   - Option A: Worker 免費贊助（目前 free pool 模式）
   - Option B: 用戶先付 MON（現有 proxy buy 模式）
   - Option C: 從 token creation 費用中扣除

### Phase 3: Upgrade 流程優化

**問題**：`upgrade-handle` 存在但 agent 不一定知道要呼叫

1. **Login 時自動偵測**：
   - 已有 `getNadNamesForWallet` 偵測
   - 但要更積極：如果偵測到 0x handle + 有 .nad → 自動建議或直接升級

2. **Upgrade 加 on-chain 驗證**：
   - 確認新 handle 的 .nad NFT 確實屬於此 wallet
   - 防止搶佔別人的 .nad handle

### Phase 4: 清理歷史數據

1. 掃描所有 `nad_name IS NOT NULL` 的帳號
2. 逐一鏈上驗證 `ownerOf`
3. 未持有者 → `nad_name` 設 null, 加 `nad_name_status`

## 優先級

| Phase | 影響 | 工作量 | 優先級 |
|-------|------|--------|--------|
| Phase 1 | 修正誤導性 API 回應 | ~2h | 🔴 最高 |
| Phase 2 | 一條龍自動買 .nad | ~4h | 🟡 高 |
| Phase 3 | 升級流程 UX | ~2h | 🟡 高 |
| Phase 4 | 清理歷史數據 | ~1h | 🟢 中 |

## BaseMail 的好做法（NadMail 應該學的）

1. ✅ **On-chain verification first** — 寫 DB 前一定先查鏈
2. ✅ **Smart fallback** — auto_basename 失敗時自動查 ownership
3. ✅ **Hint-rich error messages** — 每個錯誤都帶下一步建議
4. ✅ **upgrade_hint in response** — 主動引導用戶下一步
5. ✅ **check endpoint 區分 status** — available / taken / reserved

## 備註

- Manus 的案例：帶 `handle: "manusclaw"` 註冊 → NNS 上 `manusclaw` available → 通過檢查 → DB 寫 `nad_name: manusclaw.nad` → 但沒有人去買
- 根源是 NadMail 把「handle reservation」和「.nad ownership」混在一起
- BaseMail 不會有這問題因為 basename 是 prerequisite（先有 basename 才能用 basename handle）
