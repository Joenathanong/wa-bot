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

/** "7-21" -> {mulai:7, sampai:21}. Kosong / 0-24 berarti tanpa batas jam. */
function parseHours(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  const mulai = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const sampai = Math.min(24, Math.max(0, parseInt(m[2], 10)));
  if (mulai === 0 && (sampai === 24 || sampai === 0)) return null;
  return { mulai, sampai: sampai === 24 ? 0 : sampai };
}

/**
 * "8,12,16" -> [8,12,16] (jam lokal, sudah urut & tanpa duplikat).
 * Variabel yang DITULIS tetapi dikosongkan berarti "tidak ada jadwal",
 * bukan "pakai bawaan" - supaya jadwal benar-benar bisa dimatikan dari .env.
 */
function parseJamList(raw, bawaan) {
  const sumber = String(raw === undefined || raw === null ? bawaan : raw);
  const jam = sumber.split(',')
    .map((s) => parseInt(String(s).trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23);
  return Array.from(new Set(jam)).sort((a, b) => a - b);
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
    // Setelah mati listrik / restart: hanya pesan TERAKHIR yang memenuhi
    // kriteria dan belum pernah terkirim yang diteruskan. Pesan lama yang
    // juga memenuhi kriteria ditandai terproses (dilewati), bukan dikirim
    // beruntun. Setel false untuk kembali ke perilaku lama (kirim semua).
    onlyLatest: String(process.env.CATCHUP_ONLY_LATEST || 'true').toLowerCase() !== 'false',
  },

  // Pengelompokan pesan follow-up: peringatan yang terpecah menjadi beberapa
  // bagian hanya menghasilkan satu pesan mention.
  followUp: {
    windowMs: Math.max(0, toInt(process.env.FOLLOWUP_WINDOW_MS, 15000)),
    maxWaitMs: Math.max(1000, toInt(process.env.FOLLOWUP_MAX_WAIT_MS, 120000)),
  },


  // Laporan berkala dari IEG OCS (Fulfilment Dashboard).
  ocs: {
    enabled: String(process.env.OCS_ENABLED || 'false').toLowerCase() === 'true',
    baseUrl: (process.env.OCS_BASE_URL || 'https://ocs.iegsystem.id').trim().replace(/\/+$/, ''),
    username: (process.env.OCS_USERNAME || '').trim(),
    password: process.env.OCS_PASSWORD || '',
    database: (process.env.OCS_DATABASE || 'EJI_WMS').trim(),
    timeoutMs: Math.max(5000, toInt(process.env.OCS_TIMEOUT_MS, 20000)),

    // Kosong = kirim ke SEMUA WhatsApp Group yang aktif (perilaku bawaan).
    // Diisi = hanya ke group ini. Boleh JID (120...@g.us) atau nama group,
    // dipisah koma. Berguna bila laporan dashboard tidak untuk semua group.
    groupIds: parseIdList(process.env.OCS_GROUP_IDS),

    intervalMinutes: Math.max(1, toInt(process.env.OCS_INTERVAL_MINUTES, 60)),
    // true = laporan pertama menunggu pergantian jam supaya jatuh di menit :00
    alignToHour: String(process.env.OCS_ALIGN_TO_HOUR || 'true').toLowerCase() !== 'false',
    activeHours: parseHours(process.env.OCS_ACTIVE_HOURS),

    tzOffsetMinutes: toInt(process.env.OCS_TZ_OFFSET_MINUTES, 420),
    tzLabel: (process.env.OCS_TZ_LABEL || 'WIB').trim(),

    // Filter dashboard - sama persis dengan yang ada di halaman web
    dateType: (process.env.OCS_DATE_TYPE || 'dueDate').trim(),
    shop: (process.env.OCS_SHOP || 'All').trim(),
    channel: (process.env.OCS_CHANNEL || 'All').trim(),
    area: (process.env.OCS_AREA || 'All').trim(),
    shift: (process.env.OCS_SHIFT || 'All').trim(),
    role: (process.env.OCS_ROLE || 'all').trim(),

    topOperators: Math.max(0, toInt(process.env.OCS_TOP_OPERATORS, 10)),

    // Peringkat operator
    leaderboard: {
      // month = rata-rata per hari sepanjang bulan berjalan (tanggal 1 s/d hari ini)
      // today = hanya hari ini
      period: (process.env.OCS_LEADERBOARD_PERIOD || 'month').trim().toLowerCase(),
      // Peran yang dihitung. Kosongkan untuk semua peran.
      roles: parseIdList(process.env.OCS_LEADERBOARD_ROLES || 'packer,picker'),
      // Buang operator yang namanya MEMUAT kata ini - untuk menyingkirkan
      // akun non-manusia seperti mesin packing dan akun SYSTEM.
      exclude: parseIdList(process.env.OCS_LEADERBOARD_EXCLUDE || 'mesin,system'),
      // Pembagi rata-rata harian:
      //   auto     = hari yang ada datanya di Throughput
      //   calendar = tanggal 1 s/d hari ini, dikurangi OCS_LEADERBOARD_OFFDAYS
      //   <angka>  = dipakai apa adanya
      days: (process.env.OCS_LEADERBOARD_DAYS || 'auto').trim().toLowerCase(),
      // Hari libur mingguan untuk mode calendar. 0=Minggu ... 6=Sabtu
      offDays: parseIdList(process.env.OCS_LEADERBOARD_OFFDAYS)
        .map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 6),
    },
    judul: (process.env.OCS_TITLE || 'FULFILMENT DASHBOARD').trim(),

    // true = kirim hanya bila ada kondisi yang perlu ditindak
    onlyWhenProblem: String(process.env.OCS_ONLY_WHEN_PROBLEM || 'false').toLowerCase() === 'true',
    ambang: {
      breachedSla: toInt(process.env.OCS_ALERT_BREACHED_SLA, 1),
      atRiskSla: toInt(process.env.OCS_ALERT_AT_RISK, 1),
      instan: toInt(process.env.OCS_ALERT_INSTAN, 1),
    },
  },

  // Laporan "Stok Menipis" - Stocks > View V2 + Report > Order > Sku.
  // Seluruh nilai di bawah bisa ditimpa lewat Menu Admin Telegram dan
  // tersimpan di database, jadi .env hanya menentukan nilai awal.
  stock: {
    enabled: String(process.env.STOCK_ENABLED || 'false').toLowerCase() === 'true',

    // Jam kirim (waktu lokal). Kosong = tidak pernah terkirim otomatis.
    hours: parseJamList(process.env.STOCK_HOURS, '8,12,16'),

    // Kosong = semua WhatsApp Group aktif. Diisi = hanya group ini
    // (JID 120...@g.us atau nama group, dipisah koma).
    groupIds: parseIdList(process.env.STOCK_GROUP_IDS),

    // KRITERIA UTAMA: DOI (Days of Inventory) = stok / rata-rata harian.
    // Menjawab "kapan habis", bukan sekadar "stoknya sedikit" - sehingga
    // SKU laris berstok besar yang habis 4 hari lagi ikut tertangkap,
    // dan barang lambat berstok kecil tidak membanjiri laporan.
    doiMax: Math.max(0, toInt(process.env.STOCK_DOI_MAX, 7)),
    // Saringan tambahan jumlah stok. 0 = TANPA batas (bawaan), karena
    // DOI sudah menjadi kriterianya.
    ambang: Math.max(0, toInt(process.env.STOCK_THRESHOLD, 0)),
    // Abaikan SKU yang rata-ratanya di bawah ini. 0 = tampilkan semua.
    // Berguna untuk menyingkirkan barang yang lakunya sangat jarang.
    minAvg: Math.max(0, Number(process.env.STOCK_MIN_AVG) || 0),
    kategori: (process.env.STOCK_CATEGORY || 'Sku').trim(),
    hanyaAktif: String(process.env.STOCK_ACTIVE_ONLY || 'true').toLowerCase() !== 'false',
    area: (process.env.STOCK_AREA || '').trim(),

    // Jendela penjualan untuk Avg Daily Sales.
    //
    // 30 hari, BUKAN 90. Angkanya dipakai untuk menjawab "habis dalam 7
    // hari ke depan?" - pertanyaan jangka pendek, yang jauh lebih baik
    // dijawab permintaan terkini daripada rata-rata tiga bulan. Panjangnya
    // sengaja kelipatan ~30 hari supaya tepat memuat satu siklus bulanan
    // penuh (gajian 25-31 dan tanggal tua 20-24), sehingga tidak berat
    // sebelah tergantung tanggal berapa laporan dijalankan.
    salesDays: Math.max(7, toInt(process.env.STOCK_SALES_DAYS, 30)),
    // OCS kadang menjawab galat untuk rentang 30 hari (teramati langsung),
    // dan pasti 504 untuk 90 hari. 15 hari terbukti aman.
    chunkDays: Math.max(1, toInt(process.env.STOCK_CHUNK_DAYS, 15)),
    platform: (process.env.STOCK_PLATFORM || 'All').trim(),
    shop: (process.env.STOCK_SHOP || 'All').trim(),

    // winsor = semua hari ikut, lonjakan ekstrem dibatasi persentil (bawaan)
    // full   = semua hari, tanpa batas
    // normal = buang payday & double date
    // median = median harian
    avgMode: (process.env.STOCK_AVG_MODE || 'winsor').trim().toLowerCase(),
    persentil: Math.min(100, Math.max(50, toInt(process.env.STOCK_PERCENTILE, 95))),
    paydayMulai: Math.min(28, Math.max(1, toInt(process.env.STOCK_PAYDAY_FROM, 25))),

    top: Math.max(1, toInt(process.env.STOCK_TOP, 20)),
    detail: String(process.env.STOCK_SHOW_DETAIL || 'true').toLowerCase() !== 'false',
    judul: (process.env.STOCK_TITLE || 'STOK MENIPIS').trim(),
  },

  // Peringatan LOCK STOCK - SKU dengan ReserveQty > AvailableQty.
  // Berjalan sebagai penjadwal sendiri, terpisah dari jalur Telegram
  // maupun dari laporan OCS/stok. Hampir semua nilai bisa diubah lewat
  // Menu Admin Telegram dan tersimpan di database.
  lock: {
    enabled: String(process.env.LOCK_ENABLED || 'false').toLowerCase() === 'true',

    intervalMinutes: Math.max(5, toInt(process.env.LOCK_INTERVAL_MINUTES, 60)),
    // Pemeriksaan PERTAMA setelah aplikasi hidup. Jangan disamakan dengan
    // jeda penuh: service yang sering di-restart tidak akan pernah sampai
    // ke pemeriksaan pertamanya kalau harus menunggu satu jam.
    firstRunMinutes: Math.max(1, toInt(process.env.LOCK_FIRST_RUN_MINUTES, 3)),
    // Penyimpangan acak (menit) di sekitar jeda di atas, supaya permintaan
    // tidak jatuh di detik yang sama persis tiap jam. 0 = tepat waktu.
    jitterMinutes: Math.max(0, toInt(process.env.LOCK_JITTER_MINUTES, 7)),
    activeHours: parseHours(process.env.LOCK_ACTIVE_HOURS),

    // Kosong = semua WhatsApp Group aktif. Boleh JID atau nama group.
    groupIds: parseIdList(process.env.LOCK_GROUP_IDS),

    // Daftar shop yang dikenal, dipakai juga untuk menebak shop dari
    // nama SKU bila belum terdaftar di Master Sku Rack.
    shops: parseIdList(process.env.LOCK_SHOPS || 'NCO,Hanasui,FYNE,EOMMA'),

    // Penyaringan tambahan di sisi OCS. Kosong = semua kategori/area.
    hanyaAktif: String(process.env.LOCK_ACTIVE_ONLY || 'true').toLowerCase() !== 'false',
    kategori: (process.env.LOCK_CATEGORY || '').trim(),
    area: (process.env.LOCK_AREA || '').trim(),

    // Master Sku Rack jarang berubah - disimpan sementara sekian menit.
    rackCacheMinutes: Math.max(1, toInt(process.env.LOCK_RACK_CACHE_MINUTES, 180)),

    // true = kirim hanya bila daftar SKU-nya BERUBAH sejak kiriman terakhir,
    // supaya PIC tidak menerima pesan identik tiap jam.
    onlyOnChange: String(process.env.LOCK_ONLY_ON_CHANGE || 'false').toLowerCase() === 'true',

    monospace: String(process.env.LOCK_MONOSPACE || 'true').toLowerCase() !== 'false',
    maxSku: Math.max(10, toInt(process.env.LOCK_MAX_SKU_WIDTH, 34)),
    maxBaris: Math.max(1, toInt(process.env.LOCK_MAX_ROWS, 40)),
  },

  // Tenggat proses berhenti. Melewati ini -> keluar paksa, supaya
  // `net stop` pada Windows Service tidak pernah macet karena Chrome.
  shutdownTimeoutMs: Math.max(3000, toInt(process.env.SHUTDOWN_TIMEOUT_MS, 10000)),

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

if (config.ocs.enabled) {
      if (!config.ocs.username || !config.ocs.password || !config.ocs.database) {
        warnings.push('OCS_ENABLED=true tetapi OCS_USERNAME/OCS_PASSWORD/OCS_DATABASE belum lengkap - laporan OCS tidak akan berjalan.');
      }
      if (config.ocs.intervalMinutes < 5) {
        warnings.push('OCS_INTERVAL_MINUTES di bawah 5 menit - laporan akan sangat sering. Pastikan ini disengaja.');
      }
    }

    return { ok: errors.length === 0, errors, warnings };
  },
};

module.exports = config;
