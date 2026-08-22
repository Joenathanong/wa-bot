'use strict';

const path = require('path');
const fs = require('fs');

// Muat .env dari root project (satu level di atas /src)
const ROOT = path.resolve(__dirname, '..');
try {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
} catch (err) {
  // dotenv tidak wajib ada saat dijalankan dengan env dari PM2 / sistem
}

function parseIdList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function toInt(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const adminIds = parseIdList(process.env.ADMIN_TELEGRAM_IDS);
const allowedChatIds = parseIdList(process.env.TELEGRAM_ALLOWED_CHAT_IDS);

// bot  = pesan dibaca lewat Bot Telegram sendiri
// user = pesan dibaca lewat AKUN Telegram (MTProto/GramJS) - satu-satunya cara
//        membaca pesan yang dikirim BOT LAIN di dalam sebuah Grup
// both = keduanya
const source = String(process.env.TELEGRAM_SOURCE || 'bot').trim().toLowerCase();

const config = {
  ROOT,
  nodeEnv: process.env.NODE_ENV || 'production',
  logLevel: process.env.LOG_LEVEL || 'info',

  telegram: {
    token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    adminIds,
    allowedChatIds,
  },

  source,
  usesBotSource: source === 'bot' || source === 'both',
  usesUserSource: source === 'user' || source === 'both',

  telegramUser: {
    apiId: toInt(process.env.TELEGRAM_API_ID, 0),
    apiHash: (process.env.TELEGRAM_API_HASH || '').trim(),
    sessionFile: process.env.TELEGRAM_USER_SESSION_FILE
      || path.join(ROOT, 'data', 'telegram-user.session'),

    // MTProto lewat TCP polos memakai port 80 dan sering dicekik firewall
    // kantor sehingga ping 10 detik gagal (Error: TIMEOUT di _updateLoop).
    // WSS memakai port 443 dan menyerupai HTTPS biasa, jauh lebih lolos.
    useWSS: String(process.env.TELEGRAM_USE_WSS || 'true').toLowerCase() !== 'false',
    connectionRetries: toInt(process.env.TELEGRAM_CONNECTION_RETRIES, 100),
    retryDelay: toInt(process.env.TELEGRAM_RETRY_DELAY_MS, 3000),
    requestRetries: toInt(process.env.TELEGRAM_REQUEST_RETRIES, 5),
    logLevel: (process.env.GRAMJS_LOG_LEVEL || 'error').trim().toLowerCase(),
  },

  whatsapp: {
    clientId: process.env.WA_CLIENT_ID || 'telegram-wa-bridge',
    sessionPath: path.join(ROOT, '.wwebjs_auth'),
    chromePath: (process.env.CHROME_PATH || '').trim() || null,
    // Sematkan build WhatsApp Web tertentu bila build terbaru memecahkan
    // whatsapp-web.js. Contoh: WA_WEB_VERSION=2.3000.1015901307
    webVersion: (process.env.WA_WEB_VERSION || '').trim() || null,
    // Batas menunggu status "ready" setelah authenticated. 0 = tanpa batas.
    readyTimeoutMs: Math.max(0, toInt(process.env.WA_READY_TIMEOUT_MS, 120000)),
  },

  catchUp: {
    limit: toInt(process.env.CATCHUP_LIMIT, 25),
    maxAgeMinutes: toInt(process.env.CATCHUP_MAX_AGE_MINUTES, 180),
  },

  // Pengelompokan pesan follow-up: peringatan yang terpecah menjadi beberapa
  // bagian hanya menghasilkan satu pesan mention.
  followUp: {
    windowMs: Math.max(0, toInt(process.env.FOLLOWUP_WINDOW_MS, 15000)),
    maxWaitMs: Math.max(1000, toInt(process.env.FOLLOWUP_MAX_WAIT_MS, 120000)),
  },

  healthCheckMs: Math.max(15000, toInt(process.env.HEALTH_CHECK_MS, 60000)),

  db: {
    path: path.isAbsolute(process.env.DB_PATH || '')
      ? process.env.DB_PATH
      : path.join(ROOT, process.env.DB_PATH || 'data/bot.db'),
  },

  // Nilai .env dipakai sebagai default awal; nilai aktifnya tersimpan di
  // tabel settings sehingga dapat diubah lewat Admin Menu.
  messageDelayMs: Math.max(3000, toInt(process.env.MESSAGE_DELAY_MS, 3000)),

  isAdmin(telegramUserId) {
    return adminIds.includes(String(telegramUserId));
  },

  isAllowedChat(chatId) {
    if (allowedChatIds.length === 0) return true; // lihat peringatan di validate()
    return allowedChatIds.includes(String(chatId));
  },

  /** @returns {{ok: boolean, errors: string[], warnings: string[]}} */
  validate() {
    const errors = [];
    const warnings = [];

    if (!config.telegram.token) {
      errors.push('TELEGRAM_BOT_TOKEN belum diisi di file .env');
    } else if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.telegram.token)) {
      warnings.push('Format TELEGRAM_BOT_TOKEN terlihat tidak biasa - pastikan disalin utuh dari @BotFather');
    }

    if (adminIds.length === 0) {
      errors.push('ADMIN_TELEGRAM_IDS belum diisi - tidak ada yang bisa membuka Admin Menu');
    } else if (adminIds.some((id) => !/^\d+$/.test(id))) {
      errors.push('ADMIN_TELEGRAM_IDS hanya boleh berisi angka yang dipisah koma');
    }

    if (!['bot', 'user', 'both'].includes(source)) {
      errors.push(`TELEGRAM_SOURCE tidak dikenal: "${source}". Isi dengan bot, user, atau both.`);
    }

    if (config.usesUserSource) {
      if (!config.telegramUser.apiId || !config.telegramUser.apiHash) {
        errors.push('TELEGRAM_SOURCE=' + source + ' membutuhkan TELEGRAM_API_ID dan TELEGRAM_API_HASH dari https://my.telegram.org');
      }
      if (!fs.existsSync(config.telegramUser.sessionFile)) {
        warnings.push('Sesi akun Telegram belum ada. Jalankan: npm run tg:login');
      }
      if (allowedChatIds.length === 0) {
        warnings.push('Mode akun membaca SEMUA chat Anda selama TELEGRAM_ALLOWED_CHAT_IDS kosong. Jalankan: npm run tg:chats');
      }
    }

    if (allowedChatIds.length === 0 && config.usesBotSource) {
      warnings.push(
        'TELEGRAM_ALLOWED_CHAT_IDS kosong - SEMUA chat akan diproses. ' +
        'Kirim /id di chat sumber lalu isi variabel ini untuk produksi.'
      );
    }

    if (!fs.existsSync(path.join(ROOT, '.env')) && !process.env.TELEGRAM_BOT_TOKEN) {
      errors.push('File .env tidak ditemukan. Salin .env.example menjadi .env terlebih dahulu.');
    }

    return { ok: errors.length === 0, errors, warnings };
  },
};

module.exports = config;
