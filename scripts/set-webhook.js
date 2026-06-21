#!/usr/bin/env node
/**
 * Script untuk set webhook Telegram ke URL Vercel kamu.
 * Jalankan sekali setelah deploy:
 *   BOT_TOKEN=xxx VERCEL_URL=https://am-bot.vercel.app node scripts/set-webhook.js
 */

const https = require("https");

const BOT_TOKEN = process.env.BOT_TOKEN;
const VERCEL_URL = process.env.VERCEL_URL;

if (!BOT_TOKEN || !VERCEL_URL) {
  console.error("❌ Set env BOT_TOKEN dan VERCEL_URL dulu!\nContoh:\n  BOT_TOKEN=xxx VERCEL_URL=https://am-bot.vercel.app node scripts/set-webhook.js");
  process.exit(1);
}

const webhookUrl = `${VERCEL_URL}/api/webhook`;
const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;

https.get(apiUrl, (res) => {
  let data = "";
  res.on("data", (chunk) => (data += chunk));
  res.on("end", () => {
    const result = JSON.parse(data);
    if (result.ok) {
      console.log(`✅ Webhook berhasil di-set ke:\n   ${webhookUrl}`);
    } else {
      console.error("❌ Gagal set webhook:", result.description);
    }
  });
}).on("error", (err) => {
  console.error("❌ Error:", err.message);
});
