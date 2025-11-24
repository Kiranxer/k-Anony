/**
 * k-Anony — Anonymous Telegram Chat Bot
 * Features:
 *  - Random matching
 *  - Gender + interest matching
 *  - Premium: match only with girls (14 hours, 300 Stars)
 *  - Admin panel (/admin)
 *  - JSON persistence
 *  - Koyeb HTTP keep-alive server
 */

require('dotenv').config();
const fs = require('fs');
const http = require('http');
const { Telegraf } = require('telegraf');

// ======= Koyeb Fix: Dummy Web Server (keeps instance alive) =======
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("k-Anony bot is running\n");
}).listen(PORT, () => {
  console.log(`🌐 Keep-alive server running on port ${PORT}`);
});

// ======= Load ENV =======
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .map(Number);

const DATA_FILE = process.env.DATA_FILE || "./data.json";

if (!BOT_TOKEN) {
  console.error("❌ ERROR: BOT_TOKEN missing in .env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ======= Persistence =======
let users = new Map();  // userId -> profile
let waiting = [];       
let banned = new Set(); 

function saveData() {
  const json = {
    users: {},
    waiting,
    banned: [...banned],
  };
  for (const [id, p] of users.entries()) {
    json.users[id] = {
      gender: p.gender,
      interests: [...p.interests],
      partnerId: p.partnerId,
      premiumGirlsUntil: p.premiumGirlsUntil,
    };
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(json, null, 2));
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    saveData();
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    users = new Map();
    for (const [id, p] of Object.entries(raw.users || {})) {
      users.set(Number(id), {
        gender: p.gender || "unknown",
        interests: new Set(p.interests || []),
        partnerId: p.partnerId || null,
        premiumGirlsUntil: p.premiumGirlsUntil || 0,
      });
    }
    waiting = raw.waiting || [];
    banned = new Set(raw.banned || []);
    console.log("✅ Data loaded");
  } catch (e) {
    console.error("Failed loading data:", e);
  }
}

loadData();
setInterval(saveData, 30_000);

// ======= Utilities =======
function isAdmin(id) {
  return ADMIN_IDS.includes(Number(id));
}

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, {
      gender: "unknown",
      interests: new Set(),
      partnerId: null,
      premiumGirlsUntil: 0,
    });
  }
  return users.get(id);
}

function hasPremium(profile) {
  return profile.premiumGirlsUntil > Date.now();
}

function canMatch(a, b) {
  const A = getUser(a);
  const B = getUser(b);

  if (hasPremium(A) && B.gender !== "girl") return false;

  return true;
}

// ======= Matching =======
async function matchUser(ctx) {
  const id = ctx.from.id;

  if (banned.has(id)) return ctx.reply("⛔ You are banned.");

  const p = getUser(id);

  if (p.partnerId) {
    return ctx.reply("You are already chatting. Use /next.");
  }

  waiting = waiting.filter((x) => x !== id);

  if (waiting.length === 0) {
    waiting.push(id);
    saveData();
    return ctx.reply("⌛ Waiting for someone...");
  }

  let best = null;
  let bestScore = -1;

  for (const other of waiting) {
    if (other === id) continue;
    if (!canMatch(id, other)) continue;

    const op = getUser(other);

    let score = 0;
    for (const i of p.interests) {
      if (op.interests.has(i)) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      best = other;
    }
  }

  if (best == null) {
    waiting.push(id);
    saveData();
    return ctx.reply("⌛ Searching for a better match...");
  }

  waiting = waiting.filter((x) => x !== best);

  p.partnerId = best;
  getUser(best).partnerId = id;

  await bot.telegram.sendMessage(id, `🎉 Connected! Say hi!\nUse /next to skip, /stop to leave.`);
  await bot.telegram.sendMessage(best, `🎉 Connected! Say hi!\nUse /next to skip, /stop to leave.`);
  saveData();
}

// ======= Commands =======

bot.start(async (ctx) => {
  ctx.reply(
    "*Welcome to k-Anony 🔥*\n" +
    "Anonymous chat with matching.\n\n" +
    "*Commands:*\n" +
    "/start – find partner\n" +
    "/next – skip\n" +
    "/stop – end chat\n" +
    "/gender girl|boy|other\n" +
    "/interests <tags>\n" +
    "/profile – your data\n" +
    "/girls – premium girl-only matching (14 hrs)\n" +
    "/admin – admin panel (admins only)",
    { parse_mode: "Markdown" }
  );
  return matchUser(ctx);
});

bot.command("gender", async (ctx) => {
  const raw = ctx.message.text.split(" ")[1];
  if (!raw) return ctx.reply("Use: /gender girl|boy|other");

  const g = raw.toLowerCase();
  const val = (g.startsWith("g") ? "girl" 
            : g.startsWith("b") ? "boy" 
            : "other");

  getUser(ctx.from.id).gender = val;
  saveData();
  ctx.reply(`✅ Gender set to: ${val}`);
});

bot.command("interests", (ctx) => {
  const list = ctx.message.text
    .split(" ")
    .slice(1)
    .join(" ")
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean);

  getUser(ctx.from.id).interests = new Set(list);
  saveData();

  ctx.reply("✅ Interests updated: " + list.join(", "));
});

bot.command("profile", (ctx) => {
  const p = getUser(ctx.from.id);
  ctx.reply(
    `👤 *Profile*\n` +
    `Gender: ${p.gender}\n` +
    `Interests: ${[...p.interests].join(", ") || "none"}\n` +
    `Premium: ${hasPremium(p) ? "active" : "no"}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("next", async (ctx) => {
  const p = getUser(ctx.from.id);
  if (p.partnerId) {
    bot.telegram.sendMessage(p.partnerId, "⚠️ Stranger skipped you.");
    getUser(p.partnerId).partnerId = null;
  }
  p.partnerId = null;
  saveData();
  ctx.reply("🔄 Finding new partner...");
  matchUser(ctx);
});

bot.command("stop", (ctx) => {
  const p = getUser(ctx.from.id);
  if (p.partnerId) {
    bot.telegram.sendMessage(p.partnerId, "⚠️ Stranger ended the chat.");
    getUser(p.partnerId).partnerId = null;
  }
  p.partnerId = null;
  saveData();
  ctx.reply("👋 Chat ended.");
});

// ======= Premium Purchase =======
bot.command("girls", (ctx) => {
  ctx.replyWithInvoice({
    title: "Girl-only Matching (14 hrs)",
    description: "Match only with girls for 14 hours.",
    payload: "girls-premium",
    provider_token: "",
    currency: "XTR",
    prices: [{ label: "14h Girls Only", amount: 300 }],
  });
});

bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true));

bot.on("successful_payment", (ctx) => {
  const p = getUser(ctx.from.id);
  p.premiumGirlsUntil = Date.now() + 14 * 60 * 60 * 1000;
  saveData();
  ctx.reply("⭐ Premium activated for 14 hours!");
});

// ======= Chat Relay =======
bot.on("text", async (ctx) => {
  const id = ctx.from.id;
  const text = ctx.message.text;

  if (text.startsWith("/")) return;

  const p = getUser(id);
  if (!p.partnerId) return ctx.reply("⌛ Still searching...");

  try {
    await bot.telegram.sendMessage(p.partnerId, text);
  } catch (e) {
    p.partnerId = null;
    ctx.reply("❌ Partner unreachable. Matching new one...");
    matchUser(ctx);
  }
});

// ======= Admin Panel =======

bot.command("admin", (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Not admin.");

  ctx.reply(
    "⚙️ *k-Anony Admin Panel*\n\n" +
    "/stats\n" +
    "/ban <id>\n" +
    "/unban <id>\n" +
    "/broadcast <msg>\n" +
    "/list_waiting\n" +
    "/list_users\n" +
    "/shutdown",
    { parse_mode: "Markdown" }
  );
});

bot.command("stats", (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  ctx.reply(
    `📊 *Stats*\nUsers: ${users.size}\nWaiting: ${waiting.length}\nBanned: ${banned.size}`,
    { parse_mode: "Markdown" }
  );
});

bot.command("ban", (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = Number(ctx.message.text.split(" ")[1]);
  banned.add(id);
  saveData();
  ctx.reply(`🚫 Banned ${id}`);
});

bot.command("unban", (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const id = Number(ctx.message.text.split(" ")[1]);
  banned.delete(id);
  saveData();
  ctx.reply(`🟢 Unbanned ${id}`);
});

bot.command("broadcast", (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const msg = ctx.message.text.split(" ").slice(1).join(" ");
  for (const id of users.keys()) {
    bot.telegram.sendMessage(id, "📢 ADMIN:\n" + msg).catch(() => {});
  }
  ctx.reply("Broadcast sent.");
});

bot.command("list_waiting", (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  ctx.reply("Waiting users:\n" + waiting.join("\n"));
});

bot.command("list_users", (ctx) => {
  if (!isAdmin(ctx.from.id)) return;

  const out = [...users.keys()].slice(0, 100).join("\n");
  ctx.reply(out || "No users");
});

bot.command("shutdown", (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  ctx.reply("Shutting down...");
  process.exit(0);
});

// ======= Launch =======
bot.launch().then(() => console.log("🤖 k-Anony bot started"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
