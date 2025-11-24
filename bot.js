/**
 * k-Anony - Anonymous Telegram chat bot
 * Features:
 * - Random matching with gender + interest matching
 * - /girls premium (300 Stars for 14 hours)
 * - Admin panel via Telegram commands
 * - Small on-disk persistence to data.json
 *
 * Dependencies: telegraf, dotenv
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s));
const DATA_FILE = process.env.DATA_FILE || './data.json';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------- In-memory structures (persisted to disk) ----------
let waiting = []; // array of userIds waiting
let users = new Map(); // userId -> profile object
let banned = new Set(); // banned user ids

// Default data structure persisted
const defaultData = {
  users: {},      // userId -> profile
  waiting: [],    // array
  banned: []      // array
};

// ---------- Persistence helpers ----------
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      saveData();
      return;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    // load users
    users = new Map();
    for (const [k, v] of Object.entries(parsed.users || {})) {
      users.set(Number(k), {
        gender: v.gender || 'unknown',
        interests: new Set(v.interests || []),
        partnerId: v.partnerId || null,
        premiumGirlsUntil: v.premiumGirlsUntil || 0
      });
    }
    waiting = (parsed.waiting || []).map((x) => Number(x));
    banned = new Set((parsed.banned || []).map((x) => Number(x)));
    console.log('✅ Data loaded from', DATA_FILE);
  } catch (err) {
    console.error('Failed to load data:', err);
  }
}

function saveData() {
  try {
    const usersObj = {};
    for (const [k, v] of users.entries()) {
      usersObj[k] = {
        gender: v.gender,
        interests: Array.from(v.interests || []),
        partnerId: v.partnerId || null,
        premiumGirlsUntil: v.premiumGirlsUntil || 0
      };
    }
    const payload = {
      users: usersObj,
      waiting: waiting,
      banned: Array.from(banned)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('Failed to save data:', err);
  }
}

// Autosave every 30s
setInterval(saveData, 30_000);

// Load on start
loadData();

// ---------- Utility helpers ----------
function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

function getOrCreateProfile(userId) {
  userId = Number(userId);
  if (!users.has(userId)) {
    users.set(userId, {
      gender: 'unknown',
      interests: new Set(),
      partnerId: null,
      premiumGirlsUntil: 0
    });
  }
  return users.get(userId);
}

function getPartnerId(userId) {
  const p = users.get(Number(userId));
  return p ? p.partnerId : null;
}

function hasActiveGirlsPremium(profile) {
  return profile && profile.premiumGirlsUntil && profile.premiumGirlsUntil > Date.now();
}

function genderLabel(g) {
  if (g === 'girl') return 'girl';
  if (g === 'boy') return 'boy';
  if (g === 'other') return 'person';
  return 'person';
}

function canMatch(userId, otherId) {
  const user = getOrCreateProfile(userId);
  const other = getOrCreateProfile(otherId);

  // If user has girl-only premium → partner must be girl
  if (hasActiveGirlsPremium(user) && other.gender !== 'girl') {
    return false;
  }

  // You might implement reciprocal preferences later
  return true;
}

// Pair two users and notify them
async function pairUsers(userAId, userBId) {
  userAId = Number(userAId);
  userBId = Number(userBId);
  const profileA = getOrCreateProfile(userAId);
  const profileB = getOrCreateProfile(userBId);

  profileA.partnerId = userBId;
  profileB.partnerId = userAId;

  const interestsA = Array.from(profileA.interests);
  const interestsB = Array.from(profileB.interests);
  const shared = interestsA.filter((i) => profileB.interests.has(i));

  const infoForA =
    `✅ Connected to a stranger (${genderLabel(profileB.gender)}).\n` +
    (shared.length
      ? `You share interests: ${shared.join(', ')}`
      : interestsB.length
      ? `Their interests: ${interestsB.join(', ')}`
      : 'They did not set any interests.');

  const infoForB =
    `✅ Connected to a stranger (${genderLabel(profileA.gender)}).\n` +
    (shared.length
      ? `You share interests: ${shared.join(', ')}`
      : interestsA.length
      ? `Their interests: ${interestsA.join(', ')}`
      : 'They did not set any interests.');

  await bot.telegram.sendMessage(userAId, infoForA + '\n\nUse /next to skip, /stop to end.');
  await bot.telegram.sendMessage(userBId, infoForB + '\n\nUse /next to skip, /stop to end.');
  saveData();
}

// Disconnect user and optionally notify partner
async function disconnectUser(userId, notify = true) {
  userId = Number(userId);
  const profile = getOrCreateProfile(userId);
  const partnerId = profile.partnerId;
  if (!partnerId) return;

  profile.partnerId = null;
  const partnerProfile = getOrCreateProfile(partnerId);
  partnerProfile.partnerId = null;

  if (notify) {
    try {
      await bot.telegram.sendMessage(partnerId, '⚠️ The stranger left the chat.\nSend /start to find a new one.');
    } catch (err) {
      // ignore send errors
    }
  }
  saveData();
}

// Clean waiting entries pointing to disconnected users
function cleanWaiting() {
  waiting = waiting.filter((id) => {
    // remove banned users too
    if (banned.has(id)) return false;
    return true;
  });
}

// Core matching function
async function matchUser(ctx) {
  const userId = Number(ctx.from.id);

  if (banned.has(userId)) {
    await ctx.reply('⛔ You are banned from using this bot.');
    return;
  }

  const profile = getOrCreateProfile(userId);

  // Already chatting?
  if (profile.partnerId) {
    await ctx.reply('You are already chatting with someone.\nUse /next to find another person.');
    return;
  }

  // remove if present
  waiting = waiting.filter((id) => id !== userId);

  // if nothing waiting, push and wait
  if (waiting.length === 0) {
    waiting.push(userId);
    await ctx.reply('⌛ Waiting for another user…\nTip: Set your /gender and /interests for better matches.');
    saveData();
    return;
  }

  // Find best candidate by shared interest score & canMatch
  let bestCandidate = null;
  let bestScore = -1;

  // iterate over a copy because we may mutate waiting
  for (const otherId of [...waiting]) {
    if (otherId === userId) continue;
    if (!canMatch(userId, otherId)) continue;

    const otherProfile = getOrCreateProfile(otherId);
    let score = 0;
    for (const interest of profile.interests) {
      if (otherProfile.interests.has(interest)) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = otherId;
    }
  }

  // No suitable candidate (e.g., premium filter) => push to waiting
  if (bestCandidate == null) {
    waiting.push(userId);
    await ctx.reply('⌛ Waiting for a suitable user to connect you with…');
    saveData();
    return;
  }

  // Remove bestCandidate from waiting
  waiting = waiting.filter((id) => id !== bestCandidate);
  await pairUsers(userId, bestCandidate);
}

// ---------- Commands (user) ----------

bot.start(async (ctx) => {
  await ctx.reply(
    '👋 Welcome to *k-Anony* — anonymous chat with matching.\n\n' +
    'Commands:\n' +
    '/start – find a partner\n' +
    '/next – skip to next\n' +
    '/stop – end chat\n' +
    '/gender <girl|boy|other> – set your gender\n' +
    '/interests <tags> – set interests, e.g. /interests roblox, anime\n' +
    '/profile – view your settings\n' +
    '/girls – buy 14 hours of girl-only matching (300 ⭐)\n' +
    '/premium – check premium status\n\n' +
    'Note: Gender is self-declared.'
  , { parse_mode: 'Markdown' });

  await matchUser(ctx);
});

bot.command('gender', async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(/\s+/).slice(1).join(' ').toLowerCase().trim();
  if (!args) {
    await ctx.reply('Usage: /gender girl | boy | other');
    return;
  }
  let value = null;
  if (['girl', 'g', 'female', 'f'].includes(args)) value = 'girl';
  if (['boy', 'b', 'male', 'm'].includes(args)) value = 'boy';
  if (['other', 'o', 'any'].includes(args)) value = 'other';
  if (!value) {
    await ctx.reply('Unknown gender. Use: /gender girl | boy | other');
    return;
  }
  const profile = getOrCreateProfile(userId);
  profile.gender = value;
  saveData();
  await ctx.reply(`✅ Gender set to: ${value}`);
});

bot.command('interests', async (ctx) => {
  const userId = ctx.from.id;
  const raw = ctx.message.text.split(/\s+/).slice(1).join(' ').toLowerCase();
  if (!raw.trim()) {
    await ctx.reply('Usage: /interests roblox, anime, gaming\nSeparate interests with commas or spaces.');
    return;
  }
  const pieces = raw
    .split(/[,\n]/)
    .join(' ')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const profile = getOrCreateProfile(userId);
  profile.interests = new Set(pieces);
  saveData();
  await ctx.reply(`✅ Interests updated: ${pieces.join(', ')}\nNew matches will try to share some of these.`);
});

bot.command('profile', async (ctx) => {
  const userId = ctx.from.id;
  const profile = getOrCreateProfile(userId);
  const interests = Array.from(profile.interests || []);
  let premiumText = 'no';
  if (hasActiveGirlsPremium(profile)) {
    const remainingMs = profile.premiumGirlsUntil - Date.now();
    const hours = Math.ceil(remainingMs / (60 * 60 * 1000));
    premiumText = `girl-only active (${hours}h left)`;
  }
  await ctx.reply(
    `🧾 Your profile:\n• Gender: ${profile.gender}\n• Interests: ${interests.length ? interests.join(', ') : 'none'}\n• Premium: ${premiumText}`
  );
});

bot.command('next', async (ctx) => {
  const userId = ctx.from.id;
  await disconnectUser(userId);
  await ctx.reply('⏭ Searching for a new partner…');
  await matchUser(ctx);
});

bot.command('stop', async (ctx) => {
  const userId = ctx.from.id;
  await disconnectUser(userId);
  waiting = waiting.filter((id) => id !== Number(userId));
  saveData();
  await ctx.reply('👋 Chat ended. Use /start to chat again later. Your gender and interests are saved.');
});

bot.command('premium', async (ctx) => {
  const profile = getOrCreateProfile(ctx.from.id);
  if (!hasActiveGirlsPremium(profile)) {
    await ctx.reply('❌ No active premium subscription.\nUse /girls to buy 14 hours of girl-only matching (300 ⭐).');
    return;
  }
  const remainingMs = profile.premiumGirlsUntil - Date.now();
  const hours = Math.ceil(remainingMs / (60 * 60 * 1000));
  await ctx.reply(`⭐ Premium active!\nGirl-only matching enabled.\n⏳ Time left: ~${hours} hour(s).`);
});

// Payment: /girls -> Telegram Stars
bot.command('girls', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.replyWithInvoice({
    title: 'Girl-Only Matching (14 hours)',
    description: 'Match only with girls for 14 hours. Digital feature, non-refundable.',
    payload: `girls_${userId}_${Date.now()}`,
    provider_token: '', // empty for Telegram Stars
    currency: 'XTR',
    prices: [{ label: 'Girl-Only Matching (14 hours)', amount: 300 }]
  });
});

bot.on('pre_checkout_query', async (ctx) => {
  // Accept all pre-checkout queries (could validate payload)
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('successful_payment', async (ctx) => {
  const userId = ctx.from.id;
  const profile = getOrCreateProfile(userId);
  const FOURTEEN_HOURS = 14 * 60 * 60 * 1000;
  profile.premiumGirlsUntil = Date.now() + FOURTEEN_HOURS;
  saveData();
  await ctx.reply(
    '✅ Payment successful!\nYou can now match ONLY WITH GIRLS for the next 14 hours.\nUse /start to find your premium match 💖\nNote: Gender is self-declared by users and cannot be guaranteed.'
  );
});

// Text forwarding (normal messages)
bot.on('text', async (ctx) => {
  // ignore commands here
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const userId = ctx.from.id;
  const partnerId = getPartnerId(userId);
  if (!partnerId) {
    await ctx.reply('I am still looking for a partner.\nUse /start to find one.');
    return;
  }
  try {
    await bot.telegram.sendMessage(partnerId, text);
  } catch (err) {
    // if send fails, disconnect them
    await disconnectUser(userId, false);
    await ctx.reply('Could not deliver message — partner might be offline. Searching for a new partner…');
    await matchUser(ctx);
  }
});

// ---------- Admin commands ----------

function requireAdmin(ctx) {
  const id = Number(ctx.from.id);
  if (!isAdmin(id)) {
    ctx.reply('⛔ You are not an admin.');
    return false;
  }
  return true;
}

bot.command('admin', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  await ctx.reply(
    '⚙️ k-Anony Admin Panel\n\n' +
    'Commands:\n' +
    '/stats - show counts\n' +
    '/list_users - list user summaries (first 50)\n' +
    '/list_waiting - show waiting queue\n' +
    '/ban <userId> - ban a user\n' +
    '/unban <userId> - unban a user\n' +
    '/forcepair <idA> <idB> - pair two users\n' +
    '/broadcast <text> - send message to all users (use carefully)\n' +
    '/export - save a data export and send file\n' +
    '/shutdown - gracefully stop bot'
  );
});

bot.command('stats', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const userCount = users.size;
  const waitingCount = waiting.length;
  const bannedCount = banned.size;
  const partneredCount = Array.from(users.values()).filter(u => u.partnerId).length;
  await ctx.reply(
    `📊 Stats\n• Users saved: ${userCount}\n• Waiting: ${waitingCount}\n• Currently paired entries: ${Math.floor(partneredCount / 2)}\n• Banned: ${bannedCount}`
  );
});

bot.command('list_waiting', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const list = waiting.slice(0, 200).map((id, i) => `${i+1}. ${id}`).join('\n') || '(empty)';
  await ctx.reply(`🟡 Waiting queue:\n${list}`);
});

bot.command('list_users', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const rows = [];
  let i = 0;
  for (const [id, p] of users.entries()) {
    if (i++ > 50) break;
    rows.push(`${id} • gender:${p.gender} • ints:${Array.from(p.interests).slice(0,5).join(',') || 'none'} • partner:${p.partnerId || 'none'}`);
  }
  await ctx.reply(`👥 Users (first 50):\n${rows.join('\n') || '(none)'}`);
});

bot.command('ban', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const args = ctx.message.text.split(/\s+/).slice(1);
  if (!args[0]) {
    await ctx.reply('Usage: /ban <userId>');
    return;
  }
  const id = Number(args[0]);
  banned.add(id);
  // disconnect if currently chatting
  disconnectUser(id, true).catch(()=>{});
  // remove from waiting
  waiting = waiting.filter(x => x !== id);
  saveData();
  await ctx.reply(`✅ Banned user ${id}`);
});

bot.command('unban', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const args = ctx.message.text.split(/\s+/).slice(1);
  if (!args[0]) {
    await ctx.reply('Usage: /unban <userId>');
    return;
  }
  const id = Number(args[0]);
  banned.delete(id);
  saveData();
  await ctx.reply(`✅ Unbanned user ${id}`);
});

bot.command('forcepair', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const args = ctx.message.text.split(/\s+/).slice(1);
  if (!args[0] || !args[1]) {
    await ctx.reply('Usage: /forcepair <idA> <idB>');
    return;
  }
  const a = Number(args[0]);
  const b = Number(args[1]);
  // disconnect their current partners
  await disconnectUser(a, true).catch(()=>{});
  await disconnectUser(b, true).catch(()=>{});
  // remove from waiting
  waiting = waiting.filter(x => x !== a && x !== b);
  await pairUsers(a, b);
  await ctx.reply(`✅ Forced pair ${a} ↔ ${b}`);
});

bot.command('broadcast', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  const text = ctx.message.text.split(/\s+/).slice(1).join(' ');
  if (!text) {
    await ctx.reply('Usage: /broadcast <text>');
    return;
  }
  // broadcast to all users (careful)
  let sent = 0;
  for (const id of users.keys()) {
    try {
      await bot.telegram.sendMessage(id, `📢 Admin broadcast:\n\n${text}`);
      sent++;
    } catch (err) {
      // ignore send errors
    }
  }
  await ctx.reply(`Broadcast sent to ~${sent} users.`);
});

bot.command('export', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  saveData();
  try {
    await ctx.replyWithDocument({ source: DATA_FILE }, { caption: 'k-Anony data export' });
  } catch (err) {
    await ctx.reply('Failed to send export: ' + String(err));
  }
});

bot.command('shutdown', async (ctx) => {
  if (!requireAdmin(ctx)) return;
  await ctx.reply('Shutting down bot (admin command).');
  saveData();
  process.exit(0);
});

// ---------- Error handling & start ----------
bot.catch((err, ctx) => {
  console.error(`Bot error for update type ${ctx.updateType}`, err);
});

bot.launch()
  .then(() => console.log('🤖 k-Anony started.'))
  .catch((err) => {
    console.error('Failed to launch bot:', err);
    process.exit(1);
  });

process.once('SIGINT', () => {
  console.log('SIGINT received — saving and stopping.');
  saveData();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  console.log('SIGTERM received — saving and stopping.');
  saveData();
  bot.stop('SIGTERM');
});
