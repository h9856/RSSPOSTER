# RSS Poster

讀網站的 RSS，用 Claude 替每篇文章寫一則社群貼文，依每站的時段與上限排隊發到 X。
跑在 Cloudflare Workers，資料存 D1，附一頁網頁後台。

第一版只有 X。之後要加 Threads、FB 粉專、LINE、Discord、噗浪，都是在 `src/` 加一個發文模組，佇列與文案不用動。

## 流程

每 10 分鐘（`wrangler.toml` 的 cron）每一站依序做四件事：

1. **讀 feed**：新文章寫進 `items`。某一站**第一次**讀到時，現有文章全部標成「略過」，不會回頭補發。
2. **過期**：文章發布超過 `maxAgeHours` 還沒發出去就放棄，新聞不發隔夜的。
3. **寫文案**：每輪每站最多寫 3 篇。`review: true` 的站寫完先停在「待核准」，要到後台按「核准排入」。
4. **發文**：每輪每站最多發 1 篇，還要同時符合發文時段、每日上限、與上一篇的間隔。

`DRY_RUN = "1"` 時第 4 步只記成「空跑」，不會呼叫 X。先用空跑看幾天文案，再改成 `"0"`。

## 狀態

| 狀態 | 意思 |
|---|---|
| new | 待寫文案 |
| review | 文案寫好，等人核准 |
| ready | 排隊待發 |
| posted／dryrun | 已發／空跑 |
| skipped／expired／failed | 略過／過期／失敗三次以上 |

## 站台設定

站台清單與各站的 X 金鑰放在 secret `SITES`（JSON 陣列），**不進 repo**。格式見 `sites.example.json`：

| 欄位 | 說明 |
|---|---|
| `id` | 代號，寫進資料庫，定了就不要改 |
| `feed` | RSS 網址 |
| `voice` | 這個站的語氣說明，接在 `src/compose.ts` 的共用寫作規則後面 |
| `dailyMax` | 每個站台日最多發幾篇 |
| `minGapMinutes` | 兩篇至少隔幾分鐘 |
| `hours` | 可發文時段 `[開始, 結束)`，站台時間的小時，24 代表午夜 |
| `maxAgeHours` | 文章發布超過幾小時就不發 |
| `review` | 是否要人工核准 |
| `excludeCategories` | 帶有這些分類或標籤名稱（照 feed 裡的寫法）的文章不進佇列 |
| `utcOffset` | 站台時區，預設 8 |
| `x` | 該站 X 帳號的四把金鑰（OAuth 1.0a） |

## 部署

```bash
npm install
npx wrangler login
npx wrangler d1 create rssposter        # 把回傳的 database_id 填進 wrangler.toml
npm run db:init
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SITES < sites.json   # sites.json 已被 .gitignore 排除
npm run deploy
```

後台就是 Worker 的網址，瀏覽器會跳登入框，帳號隨意、密碼是 `ADMIN_PASSWORD`。

## X 金鑰

每個站用自己的 X 帳號，在 developer.x.com 各開一個 App：

1. User authentication settings 設成 **Read and write**（要先設好再產生 token，不然 token 只有讀取權）。
2. Keys and tokens 頁產生 API Key／Secret 與 Access Token／Secret，填進該站的 `x`。

## 本機測試

```bash
npm test          # 字數計算、OAuth 簽章、feed 解析
npm run typecheck
npm run db:init:local
npm run dev       # 需要 .dev.vars，內容同上面三個 secret
```

## 本機圖卡工具

`local/` 是另一條獨立的流程：每篇新文章產出一張 1080×1350 直式圖卡加一則貼文，存在本機，不上傳也不發文。

```bash
npm run cards -- news                # 處理 feed 裡還沒做過的文章，預設最新 5 篇
npm run cards -- news --limit 10
npm run cards -- --render out/news/2026-09-24/1047-some-article
```

每篇一個資料夾，`out/<站台>/<站台日期>/<時分>-<網址代稱>/`：

| 檔案 | 內容 |
|---|---|
| `card.jpg` | 圖卡 |
| `post.txt` | 貼文內文，最後一行是文章網址 |
| `meta.json` | 文案與版型設定，改完用 `--render` 重畫 |
| `source.img` | 原始首圖，重畫時用 |

`out/<站台>/seen.json` 記錄做過的文章，重跑不會重複產出。

**有沒有 AI 都能跑。** 有 `ANTHROPIC_API_KEY` 就由 Claude 寫文字；沒有（或加 `--no-ai`）就用文章標題排一版草稿：大標照詞界斷成最多 3 行（放不下的截掉），分類取 feed 的第一個分類，底部取標題裡的《》，`meta.json` 標 `"draft": true`。手填流程就是改 `meta.json` 再 `--render`。

**圖片**取文章頁的 og:image。放大超過 1.6 倍才能填滿的小圖、或比例寬於 2.2:1 的橫幅，自動改用 `framed` 版型（模糊底圖上放完整原圖），其餘用 `cover` 裁切填滿，裁切位置由 sharp 的注意力偵測決定。

**文字**由 Claude 一次產出貼文、圖卡大標（2 到 3 行，每行 9 字以內）、分類小字與底部作品名。feed 只有摘要的站會改讀文章頁全文。

**手動修正**：編輯 `meta.json` 後跑 `--render`。
- `copy.lines`：大標，一個元素一行
- `copy.label`、`copy.footer`：分類小字、底部作品名
- `focus`：`auto`／`left`／`center`／`right`／`top`，裁切位置
- `layout`：`cover`／`framed`

**版型設定**在站台的 `card` 欄位：`brand` 品牌字、`accent` 分類小字顏色、`logo` 右上角標誌檔（可省略，省略就用品牌字）。字型是思源黑體（Noto Sans TC），每張只從 Google Fonts 抓用到的字，快取在 `.cache/fonts/`。

## 文案規則

寫在 `src/compose.ts` 的 `RULES`，所有站共用：繁中台灣用語、主詞在前的事實陳述、不用問句與懸念、不用破折號、不補文章沒有的資訊、不自稱本站。
每站差異寫在 `voice`。X 的字數以 twitter-text 規則計算（中文算 2、網址固定 23），超過就請 Claude 縮短重寫一次，還是太長就退回用文章標題。
