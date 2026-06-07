# WordVault

固定間隔複習 ＋ 到期自動推播提醒的英文單字 PWA。整個 App 的核心價值就在「推播」——
本文件會一步步帶你把推播後端接上 [Supabase](https://supabase.com)，讓單字到期時手機真的會跳通知。

## 架構總覽

```
index.html (前端，PWA)              Supabase (後端)
┌─────────────────────┐            ┌──────────────────────────┐
│ IndexedDB            │  同步 ──▶  │ word_schedule            │
│  folders / words     │  「何時    │ push_subscriptions       │
│  （唯一的真實資料源） │   到期」   │                          │
│                      │            │ pg_cron（每分鐘）         │
│ Service Worker ◀──── │  Web Push  │  → send-due-notifications│
│  顯示通知 / 點擊進入  │            │     Edge Function        │
│  指定單字的複習畫面   │            │                          │
└─────────────────────┘            └──────────────────────────┘
```

- **前端是純靜態的單一 `index.html`**：所有單字、資料夾都存在裝置的 IndexedDB
  裡，離線也能正常複習。
- **後端只知道「每個單字何時到期」**：前端在新增單字、或翻牌評分後改變了下次
  複習時間時，會把那一筆輕量資料同步過去；真正的單字庫永遠留在你的裝置上。
- **每台裝置用 Supabase 的「匿名登入」取得一個安全身分**：不需要註冊帳號或輸入
  email，但仍然能用資料列級安全性（RLS）保護資料——即使原始碼公開在 GitHub 上，
  別人也讀不到、改不了你的複習進度或推播訂閱。

---

## 事前準備

- 一個 [Supabase](https://supabase.com) 帳號（Free Plan 即可）
- 本機安裝 Node.js（用來產生 VAPID 金鑰、部署 Edge Function）
- Supabase CLI：`npm install -g supabase`

---

## 設定步驟

### 1. 建立 Supabase 專案

到 [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**，
取個名字、設定資料庫密碼（記得存起來）、選個區域，等待約一兩分鐘建立完成。

### 2. 開啟「匿名登入」

前端不會有登入畫面，但每台裝置仍需要一個安全的身分才能讓 RLS 生效。到：

**Authentication → Sign In / Providers → Anonymous Sign-Ins** 打開開關並儲存。

> 如果找不到這個選項，在 Dashboard 上方搜尋框打「anonymous」就能直接跳過去。

### 3. 建立資料表

打開 **SQL Editor → New query**，貼上整份 [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
的內容，按 **Run**。

這會建立兩張表（`push_subscriptions`、`word_schedule`）並打開 RLS，
也會嘗試啟用 `pg_cron`、`pg_net` 兩個延伸套件。

> 如果 `create extension` 那兩行出現權限錯誤：改到 **Database → Extensions**，
> 搜尋 `pg_cron` 和 `pg_net` 個別啟用，再重新執行一次整份 SQL 即可（`if not exists`
> 讓它可以安全地重複執行）。

### 4. 產生 VAPID 金鑰

Web Push 需要一組 VAPID 金鑰來證明推播是你的伺服器發出的：

```bash
npx web-push generate-vapid-keys
```

會印出一組 **Public Key** 和 **Private Key**，兩個都先存起來，等等都會用到。

### 5. 部署推播函式、設定密鑰

```bash
supabase login
supabase link --project-ref <你的-project-ref>     # 在 Project Settings → General 可找到

# CRON_SECRET 是你自己取的任意亂數字串，純粹用來讓「排程」跟「函式」互相認識
supabase secrets set \
  VAPID_PUBLIC_KEY="<步驟4的 Public Key>" \
  VAPID_PRIVATE_KEY="<步驟4的 Private Key>" \
  VAPID_SUBJECT="mailto:you@example.com" \
  CRON_SECRET="<隨便一串夠長的亂碼，例如 openssl rand -hex 24 的輸出>"

supabase functions deploy send-due-notifications --no-verify-jwt
```

> `--no-verify-jwt` 很重要：這個函式是被「排程」呼叫的，不是被登入中的使用者呼叫，
> 所以要關掉 Supabase 預設「檢查使用者 JWT」的閘門，改由函式自己核對 `CRON_SECRET`。
> （`supabase/config.toml` 裡也已經設定 `verify_jwt = false`，雙重保險。）
>
> `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 不用自己設定——Edge Function 執行時
> Supabase 平台會自動提供。

### 6. 排程：每分鐘檢查一次到期單字

到 **SQL Editor**，把下面這段的 `<PROJECT-REF>`、`<CRON_SECRET>` 換成你自己的值再執行：

```sql
select cron.schedule(
  'wordvault-send-due-notifications',
  '* * * * *',  -- 每分鐘一次；最短的複習間隔是 10 分鐘，這個頻率夠用且即時
  $$
  select net.http_post(
    url := 'https://<PROJECT-REF>.supabase.co/functions/v1/send-due-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <CRON_SECRET>'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
```

確認排程是否註冊成功、或想移除重設：

```sql
select jobid, jobname, schedule, active from cron.job;
select cron.unschedule('wordvault-send-due-notifications');
```

### 7. 把設定填回前端

打開 `index.html`，找到 `<script>` 開頭的 `CONFIG` 區塊（搜尋 `YOUR-PROJECT-REF`），
把三個值換成你自己的：

| 變數 | 在哪裡找 |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Project Settings → API → Project API keys → `anon` `public` |
| `VAPID_PUBLIC_KEY` | 步驟 4 產生的 Public Key |

> 這些值都「設計上」可以公開（`anon key` 搭配 RLS 使用、VAPID public key 本來就會
> 送到瀏覽器）。真正敏感的 `service_role key` 和 VAPID **private** key 完全不會出現
> 在前端，只存在 Supabase 的 Edge Function 密鑰裡。

### 8. 放到 GitHub Pages

把整個 repo push 上 GitHub 後，到 **Settings → Pages**，Source 選擇你的分支
（例如 `main`）與根目錄，存檔後等個一兩分鐘，會拿到一個
`https://<your-username>.github.io/<repo>/` 的網址。

GitHub Pages 預設就是 HTTPS，Service Worker／推播都需要這個條件，不用額外設定。

### 9. 加到主畫面（iOS Safari）

⚠️ **這一步是推播能不能用的關鍵**：iOS／iPadOS 只有「已加入主畫面」的網頁
（獨立全螢幕模式）才能接收 Web Push，在 Safari 分頁裡開著是收不到通知的
（且需要 iOS 16.4 以上）。

1. 用 Safari 打開步驟 8 的網址
2. 點下方「分享」→「加入主畫面」
3. **改從主畫面的圖示開啟 App**，再點首頁的「啟用」卡片授權通知

---

## 本機測試

Service Worker 在 `localhost` 會被視為安全環境，所以大部分功能都可以本機測試
（推播本身因為需要真機 + HTTPS + 實際的 Supabase 專案，較難在本機完整驗證）：

```bash
python3 -m http.server 8000
# 瀏覽器開 http://localhost:8000
```

想單獨測試「到期通知」函式是否正常運作，可以略過排程、直接手動呼叫一次：

```bash
curl -X POST "https://<PROJECT-REF>.supabase.co/functions/v1/send-due-notifications" \
  -H "Authorization: Bearer <CRON_SECRET>" -H "Content-Type: application/json" -d '{}'
```

回傳的 JSON 會告訴你這次掃到了幾個到期單字、實際推播給幾個使用者。

---

## 疑難排解

| 現象 | 檢查方向 |
|---|---|
| 首頁「啟用」按鈕顯示「尚未設定」且按不下去 | `index.html` 的 `CONFIG` 還是預設的 `YOUR-...` 佔位字串，回到步驟 7 |
| 點「啟用」出現「登入失敗」 | 步驟 2 的 Anonymous Sign-Ins 沒開，或還在生效中（稍等一下重整再試） |
| 已啟用，但時間到了沒收到通知 | ① 確認用「主畫面圖示」開啟，不是 Safari 分頁（iOS）<br>② `select * from cron.job_run_details order by start_time desc limit 5;` 看排程有沒有在跑<br>③ Dashboard → Edge Functions → Logs 看 `send-due-notifications` 有沒有報錯<br>④ 確認 `index.html` 裡的 `VAPID_PUBLIC_KEY` 和函式密鑰裡的 `VAPID_PRIVATE_KEY` 是同一組產生出來的 |
| 中文翻譯一直顯示「查詢失敗」 | MyMemory 是公開、有速率限制的免費 API，暫時查不到時可以直接手動輸入；不影響其他功能 |
| 想換掉某個裝置的推播訂閱 | iOS：設定 → 通知 → WordVault 關閉，或移除主畫面圖示重新加入；之後重新點「啟用」即可覆蓋舊訂閱 |

---

## 各檔案做什麼

- `index.html` — 整個前端（畫面、互動、IndexedDB、Supabase 同步、推播訂閱）
- `sw.js` — Service Worker：PWA 離線快取、接收 Web Push、點擊通知後導回對應的複習畫面
- `manifest.json` — PWA 設定（名稱、圖示、啟動模式）
- `icon-*.png` — App 圖示
- `supabase/migrations/0001_init.sql` — 資料表結構與 RLS 規則
- `supabase/functions/send-due-notifications/` — 排程觸發、實際發送 Web Push 的 Edge Function
- `supabase/config.toml` — 告訴 Supabase CLI 這個函式不需要驗證使用者 JWT
