# LINE Bot on Vercel (群組 /s 列出成員)

## 功能
群組有人輸入 `/s`，Bot 回傳該群所有成員的顯示名稱，每人一行。若字數過長，自動分段；第一段用 reply，其餘用 push。

## 部署
1. 在 LINE Developers 建立 Messaging API Channel，取得：
   - LINE_CHANNEL_SECRET
   - LINE_CHANNEL_ACCESS_TOKEN
   並開啟：
   - Use webhook
   - Allow bot to join group chats

2. 這個專案上傳到 GitHub。

3. 在 Vercel 新增專案，連結此 Repo。於 **Environment Variables** 設定：
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`

4. Deploy 後取得網址，如 `https://xxx.vercel.app`。
   - Webhook URL 設為：`https://xxx.vercel.app/api/webhook`
   - 按 **Verify**。

5. 把 Bot 邀進群組，輸入 `/s` 測試。

## 本機開發（選用）
```bash
npm i
npm run dev
# 另用 ngrok 暴露 http://localhost:3000 為 HTTPS，設定到 LINE Webhook 測試
