'use strict';

const config = require('./config');
const logger = require('./logger').scope('APP');
const Database = require('./database');
const MessageQueue = require('./queue');
const WhatsAppService = require('./whatsapp');
const Pipeline = require('./pipeline');
const AdminMenu = require('./admin');
const TelegramService = require('./telegram');
const TelegramUserSource = require('./telegram-user');
const { KEYWORD } = require('./filter');

const startedAt = Date.now();
let db = null;
let wa = null;
let tg = null;
let tgUser = null;
let shuttingDown = false;

function banner() {
  console.log('');
  console.log('==========================================================');
  console.log('  TELEGRAM -> WHATSAPP NOTIFICATION BRIDGE');
  console.log('  Keyword: "' + KEYWORD + '"');
  console.log('  Sumber : ' + (config.source === 'user' ? 'AKUN Telegram (baca saja)'
    : config.source === 'both' ? 'Bot + Akun Telegram' : 'Bot Telegram'));
  console.log('  Mode   : ' + config.nodeEnv);
  console.log('==========================================================');
  console.log('');
}

async function main() {
  banner();

  const check = config.validate();
  for (const w of check.warnings) logger.warn(w);
  if (!check.ok) {
    for (const e of check.errors) logger.error(e);
    logger.error('Aplikasi berhenti. Perbaiki konfigurasi .env lalu jalankan lagi.');
    process.exit(1);
  }

  const berkasLog = require('./logger').logFilePath();
  if (berkasLog) logger.info('Log juga ditulis ke:', berkasLog);

  // 1. Database
  db = new Database(config.db.path);
  db.pruneProcessed(60);

  // 2. Antrean pengiriman
  const storedDelay = Number(db.getSetting('message_delay_ms', config.messageDelayMs));
  const queue = new MessageQueue({ delayMs: Math.max(3000, storedDelay || config.messageDelayMs) });
  logger.info('Jeda antar pesan WhatsApp:', queue.delayMs, 'ms');

  // 3. WhatsApp
  wa = new WhatsAppService({
    clientId: config.whatsapp.clientId,
    sessionPath: config.whatsapp.sessionPath,
    chromePath: config.whatsapp.chromePath,
    webVersion: config.whatsapp.webVersion,
    healthCheckMs: config.healthCheckMs,
    readyTimeoutMs: config.whatsapp.readyTimeoutMs,
  });

  // 4. Telegram (dijalankan lebih dulu agar admin menerima notifikasi QR)
  tg = new TelegramService({
    config,
    db,
    whatsapp: wa,
    queue,
    pipelineFactory: ({ notifyAdmins }) => new Pipeline({
      db, whatsapp: wa, queue, config, notifyAdmins,
      followUpWindowMs: db.getSetting('followup_window_ms', null) !== null
        ? Math.max(0, Number(db.getSetting('followup_window_ms')))
        : config.followUp.windowMs,
    }),
    adminFactory: ({ bot, pipeline }) => new AdminMenu({ bot, db, whatsapp: wa, queue, config, pipeline, startedAt }),
  });
  await tg.start();

  // 5. Event WhatsApp -> notifikasi admin
  wa.on('qr', (qr) => {
    // Dikirim sebagai gambar supaya tetap bisa dipindai walau aplikasi
    // berjalan sebagai Windows Service (tanpa terminal).
    tg.sendQrToAdmins(qr).catch((err) => logger.error('Gagal mengirim QR:', err.message));
  });
  wa.on('ready', async () => {
    const groups = db.listActiveWaGroups();
    if (groups.length === 0) {
      tg.notifyAdmins('WhatsApp siap. Belum ada WhatsApp Group tujuan - buka /groups untuk menambahkannya.');
      return;
    }
    const nama = [];
    for (const g of groups) {
      const name = await wa.getChatName(g.group_id);
      if (name && name !== g.name) db.updateWaGroup(g.id, { name });
      nama.push(name || g.name || g.group_id);
    }
    tg.notifyAdmins(`WhatsApp siap. ${groups.length} group tujuan: ${nama.join(', ')}`);

    // Baru sekarang susulan bisa benar-benar dikirim. Ini menutup celah saat
    // aplikasi baru start: Telegram sudah membaca pesan sementara WhatsApp
    // masih memuat, sehingga peringatan yang tertinggal sempat terlewat.
    if (tgUser && tgUser.connected) {
      try {
        await tgUser.catchUp();
      } catch (err) {
        logger.error('Susulan setelah WhatsApp siap gagal:', err.message);
      }
    }
  });
  wa.on('logged_out', (reason) => {
    tg.notifyAdmins(
      `SESI WHATSAPP DICABUT (${reason}). Peringatan stok TIDAK akan diteruskan sampai ` +
      'QR baru dipindai. Buka terminal/log aplikasi, scan QR di sana dengan HP.'
    );
  });
  wa.on('stuck', (n) => {
    tg.notifyAdmins(
      `WhatsApp macet di tahap login (percobaan ke-${n}) dan tidak pernah siap. ` +
      'Koneksi dibangun ulang otomatis.' +
      (n >= 2 ? ' Bila terus berulang, setel WA_WEB_VERSION di .env - lihat README bab 13.' : '')
    );
  });
  wa.on('recovering', (reason) => {
    tg.notifyAdmins(`Halaman WhatsApp Web bermasalah (${reason}). Koneksi dibangun ulang otomatis - tidak perlu scan QR. Pesan yang gagal akan disusulkan.`);
  });
  wa.on('auth_failure', () => tg.notifyAdmins('WhatsApp authentication failed. Perlu login ulang (hapus .wwebjs_auth).'));
  wa.on('disconnected', (r) => tg.notifyAdmins(`WhatsApp disconnected: ${r}. Bot mencoba menyambung ulang otomatis.`));

  // 6. Sumber pesan mode AKUN (untuk membaca pesan bot lain di dalam Grup)
  if (config.usesUserSource) {
    tgUser = new TelegramUserSource({
      config,
      pipeline: tg.pipeline,
      healthCheckMs: config.healthCheckMs,
      isReady: () => wa.isReady(),
    });

    let userDownSince = null;
    tgUser.on('down', (reason) => {
      if (!userDownSince) {
        userDownSince = Date.now();
        tg.notifyAdmins(`Koneksi akun Telegram terputus (${reason}). Bot mencoba menyambung ulang otomatis.`);
      }
    });
    tgUser.on('up', () => {
      if (userDownSince) {
        const menit = Math.round((Date.now() - userDownSince) / 60000);
        userDownSince = null;
        tg.notifyAdmins(`Koneksi akun Telegram pulih setelah ${menit} menit. Memeriksa pesan yang tertinggal...`);
      }
    });
    tgUser.on('caught-up', (n) => {
      tg.notifyAdmins(`${n} pesan yang tertinggal selama koneksi putus sudah diteruskan ke WhatsApp.`);
    });

    if (tg.admin) tg.admin.userSource = tgUser;
    const ok = await tgUser.start();
    if (!ok) {
      tg.notifyAdmins(
        'Pembaca akun Telegram TIDAK aktif (' + tgUser.state + '). ' +
        'Peringatan stok dari bot lain tidak akan diteruskan. Jalankan: npm run tg:login'
      );
    }
  }

  await wa.start();

  logger.info('Aplikasi berjalan. Kirim /admin ke bot Telegram Anda untuk membuka Admin Menu.');
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Menerima ${signal}, mematikan aplikasi dengan rapi...`);
  try { if (tg && tg.pipeline) await tg.pipeline.flushFollowUp(); } catch (e) { /* ignore */ }
  try { if (tgUser) await tgUser.stop(); } catch (e) { /* ignore */ }
  try { if (tg) await tg.stop(); } catch (e) { /* ignore */ }
  try { if (wa) await wa.stop(); } catch (e) { /* ignore */ }
  try { if (db) db.close(); } catch (e) { /* ignore */ }
  logger.info('Selesai. Sampai jumpa.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err && err.stack ? err.stack : err);
  logger.error('Aplikasi tetap berjalan. Periksa log di atas.');
});

main().catch((err) => {
  logger.error('Gagal menjalankan aplikasi:', err && err.stack ? err.stack : err);
  process.exit(1);
});
