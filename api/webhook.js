const axios    = require("axios");
const FormData = require("form-data");
const emailGen = require("../lib/emailGenerator");

// ─── ENV ──────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_KEY   = process.env.THERESAV_APIKEY;
const OWNER_ID  = process.env.OWNER_ID || "8656325799";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN env tidak di-set!");
if (!API_KEY)   throw new Error("THERESAV_APIKEY env tidak di-set!");

const TG       = `https://api.telegram.org/bot${BOT_TOKEN}`;
const THERESAV = "https://api.theresav.biz.id";

// ─── PERSISTENCE via /tmp ─────────────────────────────────────────────────────
// /tmp adalah satu-satunya writable path di Vercel serverless.
// Data bertahan selama instance hidup (biasanya 15-60 menit).
// Saat cold start baru, owner kirim whitelist.json ke bot untuk reload.
const fs        = require("fs");
const DB_PATH   = "/tmp/whitelist.json";
const GENLOG_PATH = "/tmp/genlog.json";

// State in-memory — selalu sync dengan file /tmp
let userWhitelist = new Set();
let ownerList     = new Set();
let genLog        = [];
let onlyGbMode    = false;
let _dbLoaded     = false; // flag: sudah load dari /tmp belum

// Load dari /tmp saat instance pertama kali dipakai
function loadDb() {
  if (_dbLoaded) return;
  _dbLoaded = true;
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
      if (Array.isArray(raw.users))  userWhitelist = new Set(raw.users.map(String));
      if (Array.isArray(raw.owners)) ownerList     = new Set(raw.owners.map(String).filter(id => String(id) !== String(OWNER_ID)));
      if (typeof raw.onlyGbMode === "boolean") onlyGbMode = raw.onlyGbMode;
      console.log(`[DB] Loaded: ${userWhitelist.size} users, ${ownerList.size} owners`);
    }
  } catch (e) { console.error("[DB] Load error:", e.message); }

  try {
    if (fs.existsSync(GENLOG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(GENLOG_PATH, "utf-8"));
      if (Array.isArray(raw)) genLog = raw;
    }
  } catch (e) { console.error("[DB] Genlog load error:", e.message); }
}

// Simpan state ke /tmp
function saveDb() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify({
      users:      Array.from(userWhitelist),
      owners:     Array.from(ownerList),
      onlyGbMode,
      updated:    new Date().toISOString()
    }, null, 2), "utf-8");
  } catch (e) { console.error("[DB] Save error:", e.message); }
}

function saveGenLog() {
  try {
    // Simpan max 500 entry terakhir
    const toSave = genLog.slice(-500);
    fs.writeFileSync(GENLOG_PATH, JSON.stringify(toSave, null, 2), "utf-8");
  } catch (e) { console.error("[DB] Genlog save error:", e.message); }
}

// ─── ROLE ─────────────────────────────────────────────────────────────────────
const isMainOwner = (id) => String(id) === String(OWNER_ID);
const isOwner     = (id) => isMainOwner(id) || ownerList.has(String(id));
const isAllowed   = (id) => isOwner(id) || userWhitelist.has(String(id));
const isGroup     = (c)  => c?.type === "group" || c?.type === "supergroup";

// ─── TELEGRAM HELPERS ─────────────────────────────────────────────────────────
async function tg(method, body) {
  try {
    const { data } = await axios.post(`${TG}/${method}`, body);
    return data;
  } catch (e) {
    // Jangan crash — log saja
    console.error(`[TG:${method}]`, e.response?.data?.description || e.message);
    return null;
  }
}

async function sendMsg(chat_id, text, extra = {}) {
  // Potong teks jika > 4096 karakter
  if (text.length > 4090) text = text.slice(0, 4087) + "...";
  return tg("sendMessage", { chat_id, text, parse_mode: "Markdown", ...extra });
}

async function editMsg(chat_id, message_id, text, extra = {}) {
  if (!message_id) return;
  if (text.length > 4090) text = text.slice(0, 4087) + "...";
  return tg("editMessageText", { chat_id, message_id, text, parse_mode: "Markdown", ...extra });
}

async function sendDoc(chat_id, filename, content, caption = "") {
  const form = new FormData();
  form.append("chat_id", String(chat_id));
  if (caption) form.append("caption", caption, { contentType: "text/plain" });
  form.append("document", Buffer.from(content, "utf-8"), { filename, contentType: "application/json" });
  return axios.post(`${TG}/sendDocument`, form, { headers: form.getHeaders() }).catch(e => {
    console.error("[sendDoc]", e.response?.data || e.message);
  });
}

async function react(chat_id, message_id, emoji) {
  return tg("setMessageReaction", { chat_id, message_id, reaction: [{ type: "emoji", emoji }] });
}

// ─── AUTO WEBHOOK ─────────────────────────────────────────────────────────────
async function autoSetWebhook(req) {
  try {
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    if (!host) return;
    const url = `https://${host}/api/webhook`;
    const { data } = await axios.get(`${TG}/getWebhookInfo`);
    if (data.result?.url === url) return;
    await tg("setWebhook", { url });
    console.log(`[Webhook] ✅ ${url}`);
  } catch (e) { console.error("[Webhook]", e.message); }
}

// ─── WHITELIST JSON ───────────────────────────────────────────────────────────
function buildJson() {
  return JSON.stringify({
    users:      Array.from(userWhitelist),
    owners:     Array.from(ownerList),
    onlyGbMode,
    updated:    new Date().toISOString()
  }, null, 2);
}

async function broadcastJson(caption = "") {
  saveDb(); // selalu persist ke /tmp dulu
  const content = buildJson();
  const targets = [OWNER_ID, ...Array.from(ownerList)];
  for (const id of targets) {
    await sendDoc(id, "whitelist.json", content, caption).catch(() => {});
  }
}

async function notifyOwners(text) {
  const targets = [OWNER_ID, ...Array.from(ownerList)];
  for (const id of targets) {
    await sendMsg(id, text).catch(() => {});
  }
}

// ─── THERESAV API ─────────────────────────────────────────────────────────────
async function theresav(path, params = {}) {
  const url = new URL(`${THERESAV}${path}`);
  url.searchParams.set("apikey", API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const { data } = await axios.get(url.toString());
  return data;
}

// ─── HELPER: parse & kirim email verifikasi ke user ──────────────────────────
function parseVerifyEmail(inboxMsg) {
  const body    = inboxMsg.message || "";
  const subject = inboxMsg.subject || "";
  const link    = inboxMsg.links?.[0] || inboxMsg.url || inboxMsg.urls?.[0] || null;
  const codeM   = body.match(/\b(\d{4,8})\b/) || subject.match(/\b(\d{4,8})\b/);
  const code    = codeM ? codeM[1] : null;
  return { body, subject, link, code, from: inboxMsg.from || "Alight Motion" };
}

function buildVerifyText(email, parsed, label = "") {
  let t =
    `📬 *${label || "Email Verifikasi Masuk!"}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    ` ◦ *Email:* \`${email}\`\n` +
    ` ◦ *Dari:* \`${parsed.from}\`\n` +
    ` ◦ *Subject:* _${parsed.subject || "Login to Alight Motion"}_\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (parsed.code) {
    t += `🔢 *Kode Verifikasi:*\n\`\`\`\n${parsed.code}\n\`\`\`\n➡️ Masukkan kode ini di Alight Motion!\n\n`;
  }
  if (parsed.link) {
    t += `🔗 *Link Verifikasi:*\n${parsed.link}\n\n➡️ Buka link ini di HP yang ada Alight Motion-nya!\n\n`;
  }
  if (!parsed.code && !parsed.link) {
    t += `📄 *Isi Email:*\n_${parsed.body.slice(0, 400) || "(kosong)"}_\n\n`;
  }

  t += `━━━━━━━━━━━━━━━━━━━━━━━━\n_Satriadevs | Codersteam_`;
  return t;
}

// ─── LIVE INBOX WATCHER ───────────────────────────────────────────────────────
// Poll inbox sampai dapat 1 email baru dari AM → kirim ke user → SELESAI.
// Timeout max 10 menit.
async function startLiveInbox(chat_id, email, knownCount, uname, userId) {
  const INTERVAL = 8000;               // cek tiap 8 detik
  const MAX_POLL = Math.ceil(10 * 60 * 1000 / 8000); // ~75 poll = 10 menit

  let seenCount = knownCount;

  for (let i = 0; i < MAX_POLL; i++) {
    await new Promise(r => setTimeout(r, INTERVAL));

    try {
      const res  = await emailGen.getInbox(email);
      if (!res.success) continue;

      const msgs    = res.result.inbox || [];
      const newMsgs = msgs.slice(seenCount);
      if (newMsgs.length === 0) continue;

      // Ada email baru dari AM → kirim ke user → STOP
      const latest = newMsgs[newMsgs.length - 1];
      const parsed  = parseVerifyEmail(latest);
      const ts      = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

      await sendMsg(chat_id, buildVerifyText(email, parsed, "🔑 Kode Verifikasi Login AM!"));

      await notifyOwners(
        `🔔 *[KODE VERIFIKASI TERKIRIM]*\n\n` +
        `👤 *User:* ${uname} (\`${userId}\`)\n` +
        `📧 *Email:* \`${email}\`\n` +
        `🔢 *Kode:* ${parsed.code ? `\`${parsed.code}\`` : "—"}\n` +
        `🔗 *Link:* ${parsed.link ? parsed.link.slice(0, 80) : "—"}\n` +
        `🕐 *Waktu:* ${ts}`
      );

      return; // ← SELESAI
    } catch (e) {
      console.error("[LiveInbox]", e.message);
    }
  }

  // Timeout tanpa email baru
  await sendMsg(chat_id,
    `⌛ *Inbox Timeout*\n\n` +
    `Tidak ada email verifikasi baru dalam 10 menit.\n` +
    `Gunakan /gtemp untuk coba lagi.\n\n` +
    `_Satriadevs | Codersteam_`
  ).catch(() => {});
}

// ─── /gtemp ───────────────────────────────────────────────────────────────────
// Flow:
//  1. Generate tempmail via scraper
//  2. Kirim ke AM → poll inbox → dapat link → auto verify (akun jadi PRO)
//  3. Beritahu user akun sudah premium + instruksi login
//  4. Live inbox aktif → tunggu kode verifikasi login dari AM → kirim ke user → STOP
async function handleGtemp(msg, domainArg) {
  const chat_id    = msg.chat.id;
  const message_id = msg.message_id;
  const user       = msg.from;
  const uname      = user.username ? `@${user.username}` : user.first_name;

  await react(chat_id, message_id, "⏳");

  const stMsg = await sendMsg(chat_id,
    `⚙️ *Generate TempMail AM*\n\n` +
    `🔄 Membuat email sementara${domainArg ? ` (\`${domainArg}\`)` : ""}...`
  );
  const sid = stMsg?.result?.message_id;

  try {
    // ── Step 1: Generate email ──
    const genResult = await emailGen.generate(domainArg || "");
    if (!genResult.success) throw new Error("Gagal generate email: " + genResult.result);
    const email = genResult.result.email;

    await editMsg(chat_id, sid,
      `⚙️ *Memproses Akun AM Premium...*\n\n` +
      `📧 Email: \`${email}\`\n` +
      `🔄 Step 1/3: Email dibuat!\n` +
      `🔄 Step 2/3: Mengirim request ke Alight Motion...`
    );

    // ── Step 2: Kirim request ke AM ──
    const sendRes = await theresav("/premium/alightmotion/send", { email });
    if (!sendRes.status) throw new Error("Gagal kirim ke AM: " + (sendRes.message || "Unknown"));

    await editMsg(chat_id, sid,
      `⚙️ *Memproses Akun AM Premium...*\n\n` +
      `📧 Email: \`${email}\`\n` +
      `✅ Step 2/3: Request terkirim!\n` +
      `🔄 Step 3/3: Menunggu link verifikasi di inbox... _(max 75 detik)_`
    );

    // ── Step 3: Poll inbox sampai dapat link verifikasi ──
    let verifyLink = null;
    let pollMsg    = null;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await emailGen.getInbox(email);
      if (res.success && res.result.inbox.length > 0) {
        pollMsg    = res.result.inbox[0];
        const p    = parseVerifyEmail(pollMsg);
        verifyLink = p.link;
        if (verifyLink) break;
      }
      if (i > 0 && i % 3 === 0) {
        await editMsg(chat_id, sid,
          `⚙️ *Memproses Akun AM Premium...*\n\n` +
          `📧 Email: \`${email}\`\n` +
          `✅ Step 2/3: Request terkirim!\n` +
          `🔄 Step 3/3: Menunggu inbox... _(${(i+1)*5}/75 detik)_`
        );
      }
    }

    if (!verifyLink) throw new Error("Link verifikasi tidak masuk dalam 75 detik. Coba domain lain.");

    await editMsg(chat_id, sid,
      `⚙️ *Memproses Akun AM Premium...*\n\n` +
      `📧 Email: \`${email}\`\n` +
      `✅ Step 3/3: Link verifikasi diterima!\n` +
      `🔄 Mengaktifkan akun Premium...`
    );

    // ── Step 4: Auto verify → akun jadi PRO ──
    const verifyRes = await theresav("/premium/alightmotion/verify", { email, link: verifyLink });
    if (!verifyRes.status) throw new Error("Gagal verifikasi: " + (verifyRes.message || "Unknown"));

    const rawDur  = verifyRes.data?.duration || verifyRes.data?.package_type || "";
    const durText = rawDur === "1_year" ? "1 Tahun" : (rawDur.replace("_", " ") || "1 Bulan");
    const ts      = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

    // Inbox sekarang punya 1 pesan (link verifikasi tadi)
    // Live inbox watcher akan mulai dari index 1 (skip pesan pertama)
    const knownCount = 1;

    // ── Step 5: Beritahu user akun sudah PRO + instruksi login ──
    await editMsg(chat_id, sid,
      `🎉 *───「 ＡＬＩＧＨＴ  ＭＯＴＩＯＮ  ＰＲＥＭＩＵＭ 」───*\n\n` +
      `⚡ _Akun berhasil diaktifkan sebagai Premium!_\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      ` ◦ *Email:* \`${email}\`\n` +
      ` ◦ *Status:* \`${verifyRes.data?.type || "success"}\`\n` +
      ` ◦ *Durasi:* \`${durText}\` ⏳\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📋 *LANGKAH LOGIN:*\n\n` +
      `1️⃣ Buka aplikasi *Alight Motion*\n` +
      `2️⃣ Pilih *"Log In"* → masukkan email di atas\n` +
      `3️⃣ Tap *"Send Login Link"*\n` +
      `4️⃣ Bot akan otomatis mengirim *kode verifikasi* ke sini dalam *10 menit*!\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📡 _Inbox sedang dipantau..._\n\n` +
      `_Satriadevs | Codersteam_`
    );
    await react(chat_id, message_id, "✅");

    // Simpan log
    genLog.push({ userId: String(user.id), username: uname, email, domain: email.split("@")[1], duration: durText, timestamp: ts });
    saveGenLog();

    // Notif owner
    await notifyOwners(
      `🔔 *[GTEMP — AKUN PREMIUM BERHASIL]*\n\n` +
      `👤 *User:* ${uname} (\`${user.id}\`)\n` +
      `💬 *Chat:* ${isGroup(msg.chat) ? msg.chat.title : "Private"}\n` +
      `📧 *Email:* \`${email}\`\n` +
      `⏳ *Durasi:* \`${durText}\`\n` +
      `🕐 *Waktu:* ${ts}\n\n` +
      `_Menunggu user login ke AM untuk kirim kode..._`
    );

    // ── Step 6: Live inbox aktif → tunggu kode login dari AM → kirim → STOP ──
    setImmediate(() => {
      startLiveInbox(chat_id, email, knownCount, uname, String(user.id)).catch(e => {
        console.error("[LiveInbox start]", e.message);
      });
    });

  } catch (e) {
    console.error("[gtemp]", e.message);
    if (sid) await editMsg(chat_id, sid, `❌ *Error:* ${e.message}`);
    await react(chat_id, message_id, "❌");
  }
}

// ─── /ampremium ───────────────────────────────────────────────────────────────
async function handleAmPremium(msg, email) {
  const chat_id = msg.chat.id;
  const mid     = msg.message_id;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    return sendMsg(chat_id, "❌ *Error:* Format email tidak valid kak!");

  await react(chat_id, mid, "⏳");
  try {
    const res = await theresav("/premium/alightmotion/send", { email: email.trim() });
    if (!res?.status) throw new Error(res?.message || "Gagal dari server.");
    await sendMsg(chat_id,
      `🎉 *───「 ＡＬＩＧＨＴ  ＭＯＴＩＯＮ 」───*\n` +
      `⚡ _${res.message || "Link verifikasi berhasil dikirim!"}_\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      ` ◦ *Target Email:* \`${res.data?.email || email}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📋 *LANGKAH AKTIVASI:*\n\n` +
      `1️⃣ Buka Gmail → cek *Folder Spam*\n` +
      `2️⃣ Klik tombol *"Login"* di email dari Alight Motion\n` +
      `3️⃣ Salin URL lengkap di address bar browser\n\n` +
      `💡 _Setelah dapat link, gunakan /amverify_\n` +
      `_Satriadevs | Codersteam_`
    );
    await react(chat_id, mid, "✅");
  } catch (e) {
    await react(chat_id, mid, "❌");
    await sendMsg(chat_id, `❌ *Gagal:* ${e.response?.data?.message || e.message}`);
  }
}

// ─── /amverify ────────────────────────────────────────────────────────────────
async function handleAmVerify(msg, args) {
  const chat_id = msg.chat.id;
  const mid     = msg.message_id;

  if (!args || !args.includes("|"))
    return sendMsg(chat_id, `🔐 *Format Salah!*\n\n/amverify email | link\n\nContoh:\n/amverify email@gmail.com | https://alight-creative.firebaseapp.com/...`);

  const [email, link] = args.split("|").map(v => v.trim());
  if (!email || !link) return sendMsg(chat_id, "⚠️ Email dan link harus diisi.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendMsg(chat_id, "❌ Format email tidak valid.");

  await react(chat_id, mid, "⏳");
  try {
    const res = await theresav("/premium/alightmotion/verify", { email, link });
    if (!res?.status) throw new Error(res?.message || "Gagal dari server.");
    const rawDur  = res.data?.duration || "";
    const durText = rawDur === "1_year" ? "1 Tahun" : (rawDur.replace("_", " ") || "—");
    await sendMsg(chat_id,
      `🎉 *───「 ＡＭ  ＶＥＲＩＦＩＣＡＴＩＯＮ 」───*\n` +
      `⚡ _${res.message || "Verifikasi berhasil!"}_\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      ` ◦ *Email:* \`${res.data?.email || email}\`\n` +
      ` ◦ *Tipe:* \`${res.data?.type || "success"}\`\n` +
      ` ◦ *Durasi:* \`${durText}\` ⏳\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ Akun kamu sudah *PRO / PREMIUM*!\n` +
      `_Satriadevs | Codersteam_`
    );
    await react(chat_id, mid, "✅");
  } catch (e) {
    await react(chat_id, mid, "❌");
    await sendMsg(chat_id, `❌ *Error:* ${e.response?.data?.message || e.message}`);
  }
}

// ─── OWNER COMMANDS ───────────────────────────────────────────────────────────
async function handleAdd(msg, tid) {
  const chat_id = msg.chat.id;
  if (!isOwner(msg.from.id)) return sendMsg(chat_id, "❌ Hanya owner.");
  if (!tid || isNaN(tid))    return sendMsg(chat_id, "❌ Format: `/add 123456789`");
  tid = String(tid);
  if (userWhitelist.has(tid) || isOwner(tid))
    return sendMsg(chat_id, `⚠️ User \`${tid}\` sudah terdaftar.`);
  userWhitelist.add(tid);
  const cap = `✅ User \`${tid}\` ditambahkan! Total user: ${userWhitelist.size}`;
  await broadcastJson(cap);
  return sendMsg(chat_id, cap + "\n📄 whitelist.json dikirim ke semua owner.");
}

async function handleRemove(msg, tid) {
  const chat_id = msg.chat.id;
  if (!isOwner(msg.from.id)) return sendMsg(chat_id, "❌ Hanya owner.");
  if (!tid || isNaN(tid))    return sendMsg(chat_id, "❌ Format: `/remove 123456789`");
  tid = String(tid);
  if (!userWhitelist.has(tid)) return sendMsg(chat_id, `⚠️ \`${tid}\` tidak ada di whitelist.`);
  userWhitelist.delete(tid);
  const cap = `🗑️ User \`${tid}\` dihapus. Sisa: ${userWhitelist.size}`;
  await broadcastJson(cap);
  return sendMsg(chat_id, cap);
}

async function handleAddOwner(msg, tid) {
  const chat_id = msg.chat.id;
  if (!isMainOwner(msg.from.id)) return sendMsg(chat_id, "❌ Hanya main owner.");
  if (!tid || isNaN(tid))        return sendMsg(chat_id, "❌ Format: `/addowner 123456789`");
  tid = String(tid);
  if (isMainOwner(tid)) return sendMsg(chat_id, "⚠️ Itu ID kamu sendiri (main owner).");
  if (ownerList.has(tid)) return sendMsg(chat_id, `⚠️ \`${tid}\` sudah jadi sub-owner.`);
  ownerList.add(tid);
  const cap = `👑 \`${tid}\` dijadikan Sub-Owner!`;
  await broadcastJson(cap);
  return sendMsg(chat_id, cap);
}

async function handleRemoveOwner(msg, tid) {
  const chat_id = msg.chat.id;
  if (!isMainOwner(msg.from.id)) return sendMsg(chat_id, "❌ Hanya main owner.");
  if (!tid || isNaN(tid))        return sendMsg(chat_id, "❌ Format: `/removeowner 123456789`");
  tid = String(tid);
  if (!ownerList.has(tid)) return sendMsg(chat_id, `⚠️ \`${tid}\` bukan sub-owner.`);
  ownerList.delete(tid);
  const cap = `🗑️ \`${tid}\` dicopot dari Sub-Owner.`;
  await broadcastJson(cap);
  return sendMsg(chat_id, cap);
}

async function handleOnlyGb(msg) {
  if (!isOwner(msg.from.id)) return sendMsg(msg.chat.id, "❌ Hanya owner.");
  onlyGbMode = !onlyGbMode;
  saveDb();
  return sendMsg(msg.chat.id, onlyGbMode
    ? `🏘️ *Mode Hanya Grup* ON\n\nBot hanya merespons pesan dari grup.`
    : `💬 *Mode Hanya Grup* OFF\n\nBot merespons semua chat.`
  );
}

async function handleListGen(msg) {
  if (!isOwner(msg.from.id)) return; // secret — diam saja
  if (genLog.length === 0) return sendMsg(msg.chat.id, `📋 *Log Generate*\n\n_Belum ada generate berhasil._`);

  const lines = genLog.map((g, i) =>
    `${i+1}. ${g.username} (\`${g.userId}\`)\n   📧 \`${g.email}\`\n   ⏳ ${g.duration} — 🕐 ${g.timestamp}`
  ).join("\n\n");

  const text = `📋 *Log Generate AM* (${genLog.length})\n\n${lines}`;
  if (text.length > 4090) {
    const content = genLog.map((g, i) =>
      `[${i+1}] ${g.username} (${g.userId})\nEmail: ${g.email}\nDomain: ${g.domain}\nDurasi: ${g.duration}\nWaktu: ${g.timestamp}\n`
    ).join("\n");
    return sendDoc(msg.chat.id, "genlog.txt", content, `📋 Log Generate AM — ${genLog.length} akun`);
  }
  return sendMsg(msg.chat.id, text);
}

async function handleListUser(msg) {
  if (!isOwner(msg.from.id)) return;
  const ul = Array.from(userWhitelist);
  const ol = Array.from(ownerList);
  return sendMsg(msg.chat.id,
    `👥 *User Whitelist* (${ul.length})\n` +
    (ul.length ? ul.map((id, i) => `${i+1}. \`${id}\``).join("\n") : "_Kosong_") +
    `\n\n👑 *Sub-Owner* (${ol.length})\n` +
    (ol.length ? ol.map((id, i) => `${i+1}. \`${id}\``).join("\n") : "_Kosong_")
  );
}

// ─── Load whitelist dari JSON kiriman owner ───────────────────────────────────
async function handleDocument(msg) {
  if (!isOwner(msg.from?.id)) return;
  const doc = msg.document;
  if (!doc?.file_name?.endsWith(".json")) return;
  try {
    const fi = await tg("getFile", { file_id: doc.file_id });
    const fp = fi?.result?.file_path;
    if (!fp) throw new Error("Tidak bisa ambil path file");
    const { data } = await axios.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fp}`, { responseType: "text" });
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed.users))  userWhitelist = new Set(parsed.users.map(String));
    if (Array.isArray(parsed.owners)) ownerList     = new Set(parsed.owners.map(String).filter(id => !isMainOwner(id)));
    if (typeof parsed.onlyGbMode === "boolean") onlyGbMode = parsed.onlyGbMode;
    saveDb(); // persist ke /tmp supaya instance lain ikut sinkron
    await sendMsg(msg.chat.id,
      `✅ *Whitelist dimuat ulang!*\n\n` +
      `👥 User: *${userWhitelist.size}*\n` +
      `👑 Sub-Owner: *${ownerList.size}*\n` +
      `🏘️ Only Grup: *${onlyGbMode ? "ON" : "OFF"}*\n\n` +
      `IDs user: ${Array.from(userWhitelist).join(", ") || "—"}`
    );
  } catch (e) { await sendMsg(msg.chat.id, `❌ Gagal baca JSON: ${e.message}`); }
}

// ─── /start ───────────────────────────────────────────────────────────────────
async function handleStart(msg) {
  const uid  = msg.from?.id;
  const name = msg.from?.first_name || "Kak";
  await tg("sendMessage", {
    chat_id: msg.chat.id,
    text:
      `👋 Halo *${name}*! Selamat datang di *AM Premium Bot* 🎬\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Pilih menu di bawah untuk mulai:`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🚀 Auto AM Premium", callback_data: "menu_gtemp"     },
          { text: "📧 Send Email AM",   callback_data: "menu_ampremium" }
        ],
        [
          { text: "✅ Verifikasi AM",   callback_data: "menu_amverify"  },
          { text: "❓ Bantuan",         callback_data: "menu_help"       }
        ],
        ...(isOwner(uid) ? [[{ text: "👑 Panel Owner", callback_data: "menu_owner" }]] : [])
      ]
    }
  });
}

// ─── CALLBACK QUERY ───────────────────────────────────────────────────────────
async function handleCallback(cb) {
  const chat_id = cb.message.chat.id;
  const uid     = cb.from.id;
  const data    = cb.data;
  await tg("answerCallbackQuery", { callback_query_id: cb.id });

  if (data === "menu_help") {
    const ownerSec = isOwner(uid)
      ? `\n\n👑 *OWNER:*\n/add /remove /addowner /removeowner /onlygb /listuser`
      : "";
    return sendMsg(chat_id,
      `📋 *COMMAND:*\n\n` +
      `🔹 /gtemp \`[domain]\` — Auto generate & verifikasi AM\n` +
      `🔹 /ampremium \`<email>\` — Kirim link ke email kamu\n` +
      `🔹 /amverify \`<email> | <link>\` — Verifikasi manual` +
      ownerSec
    );
  }

  if (data === "menu_owner") {
    if (!isOwner(uid)) return sendMsg(chat_id, "❌ Bukan owner.");
    return sendMsg(chat_id,
      `👑 *PANEL OWNER*\n\n` +
      `👥 User: *${userWhitelist.size}*\n` +
      `👑 Sub-Owner: *${ownerList.size}*\n` +
      `🏘️ Only Grup: *${onlyGbMode ? "ON ✅" : "OFF ❌"}*\n\n` +
      `/add \`<id>\` — Tambah user\n` +
      `/remove \`<id>\` — Hapus user\n` +
      `/addowner \`<id>\` — Jadikan sub-owner\n` +
      `/removeowner \`<id>\` — Copot sub-owner\n` +
      `/onlygb — Toggle mode hanya grup\n` +
      `/listuser — Lihat semua user\n` +
      `📎 _Kirim whitelist.json ke bot untuk reload._`
    );
  }

  // Cek akses untuk fitur
  if (!isAllowed(uid)) {
    return sendMsg(chat_id, `🔒 *Akses Ditolak*\n\nKamu belum di-add sama *Satria*.\nHubungi owner untuk mendapatkan akses.`);
  }

  if (data === "menu_gtemp")     return sendMsg(chat_id, `🚀 *Auto AM Premium*\n\nKetik:\n/gtemp — domain random\n/gtemp maildy.site — domain pilihan`);
  if (data === "menu_ampremium") return sendMsg(chat_id, `📧 *Send Email AM*\n\nFormat: /ampremium <email>\nContoh: /ampremium kamu@gmail.com`);
  if (data === "menu_amverify")  return sendMsg(chat_id, `✅ *Verifikasi AM*\n\nFormat: /amverify <email> | <link>`);
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────
async function processUpdate(update) {
  // Callback query (tombol inline)
  if (update.callback_query) return handleCallback(update.callback_query);

  const msg = update.message || update.channel_post;
  if (!msg) return;

  const chat = msg.chat;
  const uid  = msg.from?.id;

  // Dokumen JSON dari owner → reload whitelist
  if (msg.document) return handleDocument(msg);

  // Anggota baru bergabung di grup → tidak perlu dibalas
  if (msg.new_chat_members) return;

  if (!msg.text) return;

  const text   = msg.text.trim();
  const parts  = text.split(" ");
  const cmd    = parts[0].split("@")[0].toLowerCase();
  const args   = parts.slice(1).join(" ").trim();

  // Mode hanya grup: abaikan private (kecuali owner)
  if (onlyGbMode && !isGroup(chat) && !isOwner(uid)) return;

  // /start & /help tidak perlu whitelist
  if (cmd === "/start" || cmd === "/help") return handleStart(msg);

  // Cek whitelist
  if (!isAllowed(uid)) {
    const name = msg.from?.first_name || "kamu";
    // Di grup: hanya balas jika pesan adalah command
    if (isGroup(chat)) {
      if (!text.startsWith("/")) return; // abaikan pesan biasa di grup
      return sendMsg(chat.id, `🔒 ${name}, kamu belum di-add sama *Satria*.\nHubungi owner untuk mendapatkan akses.`);
    }
    return sendMsg(chat.id, `🔒 *Akses Ditolak*\n\nKamu belum di-add sama *Satria*.\nHubungi owner untuk mendapatkan akses.`);
  }

  // Owner commands
  if (cmd === "/onlygb")      return handleOnlyGb(msg);
  if (cmd === "/add")         return handleAdd(msg, args);
  if (cmd === "/remove")      return handleRemove(msg, args);
  if (cmd === "/addowner")    return handleAddOwner(msg, args);
  if (cmd === "/removeowner") return handleRemoveOwner(msg, args);
  if (cmd === "/listgen")     return handleListGen(msg);   // secret
  if (cmd === "/listuser")    return handleListUser(msg);

  // User commands
  if (cmd === "/gtemp") return handleGtemp(msg, args || null);

  if (["/ampremium", "/sendam", "/alightpremium", "/alightmotion"].includes(cmd)) {
    if (!args) return sendMsg(chat.id, `📧 *Format:* /ampremium <email>\nContoh: /ampremium kamu@gmail.com`);
    return handleAmPremium(msg, args);
  }

  if (["/amverify", "/alightverify", "/viam", "/verifyam"].includes(cmd)) {
    return handleAmVerify(msg, args);
  }
}

// ─── VERCEL EXPORT ────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Load state dari /tmp di setiap request (handles cold start & instance baru)
  loadDb();

  if (req.method === "GET") {
    await autoSetWebhook(req);
    return res.status(200).send("AM Premium Bot v3 is running! 🚀\nWebhook auto-configured ✅");
  }
  if (req.method === "POST") {
    autoSetWebhook(req).catch(() => {});
    try { await processUpdate(req.body); } catch (e) { console.error("[processUpdate]", e); }
    return res.status(200).json({ ok: true });
  }
  res.status(405).send("Method Not Allowed");
};
