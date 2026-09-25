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
const OcsScheduler = require('./ocs-scheduler');
const StockScheduler = require('./stock-scheduler');
const LockScheduler = require('./lock-scheduler');
const { pasangPengamanShutdown } = require('./shutdown-guard');
const tujuan = require('./tujuan');
const { KEYWORD } = require('./filter');

const startedAt = Date.now();
let db = null;
let wa = null;
let tg = null;
let tgUser = null;
let ocs = null;
let stock = null;
let lock = null;
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
  // Tanpa batas bawah paksa: 0 ms diperbolehkan dan dihormati.
  // "storedDelay || config.messageDelayMs" dulu membuat nilai tersimpan 0
  // diam-diam jatuh ke default - justru nilai yang ingin dipakai sekarang.
  const tersimpan = db.getSetting('message_delay_ms', null);
  const storedDelay = tersimpan === null ? config.messageDelayMs : Number(tersimpan);
  const queue = new MessageQueue({
    delayMs: Math.max(0, Number.isFinite(storedDelay) ? storedDelay : config.messageDelayMs),
  });
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

  // 4b. Pastikan Forwarder dan Peringatan Lock Stock tidak menumpuk di satu
  //     group. Diperiksa SAAT START, bukan hanya saat setelan diubah:
  //     setelan lama yang sudah terlanjur menumpuk tidak akan pernah lewat
  //     jalur /lockgroup lagi, jadi tanpa pemeriksaan ini ia diam selamanya.
  try {
    const pisah = tujuan.pisahkanOtomatis(db, config);
    if (pisah.dipisah.length > 0) {
      const nama = pisah.dipisah.map((g) => g.name).join(', ');
      logger.warn(`Group "${nama}" dinonaktifkan dari Forwarder - group itu tujuan Peringatan Lock Stock.`);
      tg.notifyAdmins(
        `Group "${nama}" dipakai Forwarder Telegram DAN Peringatan Lock Stock sekaligus.\n\n`
        + 'Sudah dipisah: group itu dinonaktifkan di /groups, jadi sekarang hanya '
        + 'menerima peringatan lock stock. Forward pesanan tetap ke group aktif lainnya.\n\n'
        + 'Periksa kapan saja dengan /tujuan.'
      );
    } else if (pisah.tidakBisaDipisah) {
      const peta = tujuan.petaTujuan(db, config);
      const nama = peta.bentrok.map((g) => g.name).join(', ');
      logger.warn(`Group "${nama}" dipakai dua jalur sekaligus dan tidak ada group aktif lain.`);
      tg.notifyAdmins(
        `Forwarder Telegram dan Peringatan Lock Stock sama-sama memakai group "${nama}".\n\n`
        + 'Tidak dipisah otomatis karena itu satu-satunya group aktif - forward pesanan '
        + 'tidak boleh berhenti. Pilih salah satu:\n'
        + '  a) /lockgroup <group lain>\n'
        + '  b) tambah group baru di /groups lalu nonaktifkan yang ini\n\n'
        + 'Periksa dengan /tujuan.'
      );
    }
  } catch (err) {
    logger.error('Pemeriksaan pemisahan group tujuan gagal:', err.message);
  }

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
  wa.on('stuck', (n, tahap) => {
    // Dua tahap yang sangat berbeda, dua penanganan yang berbeda pula.
    // Pesan lama hanya menulis "tahap login" sehingga tidak mungkin
    // dibedakan - dan salah satunya tidak akan pernah selesai sendiri.
    let sebab;
    if (tahap === 'qr') {
      sebab = 'Aplikasi berhenti di tahap QR: TIDAK ADA yang memindai QR-nya, '
        + 'jadi ini tidak akan pernah selesai sendiri. QR sudah dikirim ke chat ini - '
        + 'buka WhatsApp di HP > Perangkat Tertaut > Tautkan Perangkat, lalu pindai. '
        + 'QR kedaluwarsa cepat; kalau sudah pudar, tunggu QR berikutnya.';
    } else if (tahap === 'authenticated') {
      // PENTING: sarannya berlawanan arah tergantung WA_WEB_VERSION sudah
      // disematkan atau belum. Pesan lama selalu menyuruh MENYETEL, padahal
      // kalau sudah disetel justru pin itulah tersangka utamanya - build yang
      // dipatok lama-lama ditolak WhatsApp dan halaman tidak pernah selesai.
      const detik = Math.round((config.whatsapp.readyTimeoutMs || 0) / 1000);
      sebab = 'Sesi sudah sah (QR tidak perlu diulang) tetapi halaman WhatsApp Web '
        + `tidak pernah selesai dimuat dalam ${detik} detik.\n\n`;
      if (config.whatsapp.webVersion) {
        sebab += `WA_WEB_VERSION SUDAH disematkan (${config.whatsapp.webVersion}). `
          + 'Build yang dipatok itu tersangka utamanya: WhatsApp menolak build lama '
          + 'sehingga halaman menggantung. Beri tanda # pada baris WA_WEB_VERSION di '
          + '.env (jangan diganti versi lain dulu), lalu jalankan ulang.';
      } else {
        sebab += 'WA_WEB_VERSION belum disematkan. Dua kemungkinan: (a) sinkronisasi '
          + 'riwayat memang lama karena folder sesi besar - naikkan '
          + 'WA_READY_TIMEOUT_MS=300000 di .env; (b) build WhatsApp Web tidak cocok - '
          + 'sematkan WA_WEB_VERSION, lihat README bab 13. Coba (a) lebih dulu.';
      }
      sebab += ' Diagnosa lengkap: npm run wa:diag';
    } else {
      sebab = `Macet di tahap "${tahap}". Periksa log aplikasi; bila tertulis `
        + '"The browser is already running", ada proses Chrome lama yang masih '
        + 'memegang folder sesi - jalankan: taskkill /F /IM chrome.exe';
    }
    tg.notifyAdmins(`WhatsApp belum siap (percobaan ke-${n}, tahap "${tahap}").\n\n${sebab}`);
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

    // TIDAK di-await dengan sengaja.
    //
    // Dulu baris ini "await tgUser.start()". Ketika DNS bermasalah, GramJS
    // connect() menggantung di retry internalnya dan start() tidak pernah
    // selesai - sehingga penjadwal OCS/stok/lock DAN wa.start() di bawah
    // TIDAK PERNAH dijalankan. Gejalanya membingungkan: bot Telegram hidup,
    // Admin Menu menjawab, tetapi WhatsApp diam di status "stopped" berhari-hari
    // tanpa satu pun baris [WA] di log.
    //
    // Pembaca akun Telegram bukan syarat WhatsApp berjalan, jadi biarkan ia
    // menyambung di latar belakang dan lanjutkan proses start yang lain.
    tgUser.start()
      .then((ok) => {
        if (!ok) {
          tg.notifyAdmins(
            'Pembaca akun Telegram TIDAK aktif (' + tgUser.state + '). ' +
            'Peringatan stok dari bot lain tidak akan diteruskan. ' +
            'Bagian lain (WhatsApp, OCS, stok, lock) tetap berjalan. ' +
            'Bila sesi kedaluwarsa: npm run tg:login'
          );
        }
      })
      .catch((err) => {
        logger.error('Pembaca akun Telegram gagal dijalankan:', err.message);
        tg.notifyAdmins('Pembaca akun Telegram gagal dijalankan: ' + err.message);
      });
  }


  // 7. Laporan berkala Fulfilment Dashboard dari IEG OCS
  if (config.ocs.enabled) {
    ocs = new OcsScheduler({
      db, whatsapp: wa, queue, config,
      notifyAdmins: (teks) => tg.notifyAdmins(teks),
    });
    tg.ocs = ocs;
    if (tg.admin) tg.admin.ocs = ocs;
    ocs.start();
  } else {
    logger.info('Laporan OCS tidak aktif (OCS_ENABLED belum true di .env).');
  }

  // 8. Laporan "Stok Menipis" pada jam-jam tertentu
  if (config.stock.enabled) {
    stock = new StockScheduler({
      db, whatsapp: wa, queue, config,
      notifyAdmins: (teks) => tg.notifyAdmins(teks),
    });
    tg.stock = stock;
    if (tg.admin) tg.admin.stock = stock;
    stock.start();
  } else {
    logger.info('Laporan stok tidak aktif (STOCK_ENABLED belum true di .env).');
  }

  // 9. Peringatan LOCK STOCK (reserve melebihi stok tersedia)
  if (config.lock.enabled) {
    lock = new LockScheduler({
      db, whatsapp: wa, queue, config,
      notifyAdmins: (teks) => tg.notifyAdmins(teks),
    });
    tg.lock = lock;
    if (tg.admin) tg.admin.lock = lock;
    lock.start();
  } else {
    logger.info('Peringatan lock stock tidak aktif (LOCK_ENABLED belum true di .env).');
  }

  await wa.start();

  logger.info('Aplikasi berjalan. Kirim /admin ke bot Telegram Anda untuk membuka Admin Menu.');
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Menerima ${signal}, mematikan aplikasi dengan rapi...`);

  // Windows Service hanya memberi waktu terbatas untuk berhenti. Bila Chrome
  // menggantung, `net stop` gagal dan service tersangkut di STOP_PENDING.
  const pengaman = pasangPengamanShutdown(config.shutdownTimeoutMs);
  try { if (tg && tg.pipeline) await tg.pipeline.flushFollowUp(); } catch (e) { /* ignore */ }
  try { if (ocs) ocs.stop(); } catch (e) { /* ignore */ }
  try { if (stock) stock.stop(); } catch (e) { /* ignore */ }
  try { if (lock) lock.stop(); } catch (e) { /* ignore */ }
  try { if (tgUser) await tgUser.stop(); } catch (e) { /* ignore */ }
  try { if (tg) await tg.stop(); } catch (e) { /* ignore */ }
  try { if (wa) await wa.stop(); } catch (e) { /* ignore */ }
  try { if (db) db.close(); } catch (e) { /* ignore */ }
  pengaman.batalkan();
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
