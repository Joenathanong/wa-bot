'use strict';

const logger = require('./logger').scope('TG');
const { KEYWORD } = require('./filter');

/**
 * Lapisan Telegram: polling, perintah, routing ke Admin Menu dan Pipeline.
 * SATU ARAH: aplikasi tidak pernah membaca WhatsApp untuk dikirim ke Telegram.
 */
class TelegramService {
  constructor({ config, db, whatsapp, queue, pipelineFactory, adminFactory }) {
    this.config = config;
    this.db = db;
    this.wa = whatsapp;
    this.queue = queue;
    this.pipelineFactory = pipelineFactory;
    this.adminFactory = adminFactory;
    this.bot = null;
    this.pipeline = null;
    this.admin = null;
    this.connected = false;
  }

  async start() {
    const TelegramBot = require('node-telegram-bot-api');
    this.bot = new TelegramBot(this.config.telegram.token, {
      polling: { interval: 1000, autoStart: true, params: { timeout: 30 } },
    });

    this.pipeline = this.pipelineFactory({ notifyAdmins: (t) => this.notifyAdmins(t) });
    this.admin = this.adminFactory({ bot: this.bot, pipeline: this.pipeline });

    this.bot.on('message', (msg) => this._safe(() => this.onMessage(msg), 'message'));
    this.bot.on('channel_post', (msg) => this._safe(() => this.onMessage(msg), 'channel_post'));
    this.bot.on('callback_query', (q) => this._safe(() => this.onCallback(q), 'callback_query'));

    this.bot.on('polling_error', (err) => {
      this.connected = false;
      logger.error('Telegram polling error:', err.code || '', err.message);
    });
    this.bot.on('error', (err) => logger.error('Telegram error:', err.message));

    try {
      const me = await this.bot.getMe();
      this.connected = true;
      logger.info(`Telegram connected sebagai @${me.username} (id ${me.id})`);
    } catch (err) {
      logger.error('Gagal menghubungi Telegram API:', err.message);
      logger.error('Periksa TELEGRAM_BOT_TOKEN dan koneksi internet. Bot akan terus mencoba.');
    }
    return this;
  }

  async stop() {
    if (this.bot) {
      try { await this.bot.stopPolling(); } catch (e) { /* ignore */ }
    }
    this.connected = false;
  }

  _safe(fn, label) {
    Promise.resolve()
      .then(fn)
      .catch((err) => logger.error(`Error menangani ${label}:`, err && err.message));
  }

  /**
   * Kirim QR WhatsApp ke seluruh admin. Wajib ada ketika aplikasi berjalan
   * sebagai Windows Service, karena tidak ada terminal untuk menampilkannya.
   */
  async sendQrToAdmins(qrData) {
    if (!this.bot) return false;
    const { renderQrPng } = require('./qr');
    const png = await renderQrPng(qrData);

    const caption = [
      '📲 SCAN QR INI UNTUK MENGHUBUNGKAN WHATSAPP',
      '',
      'Di HP: WhatsApp → Setelan → Perangkat Tertaut → Tautkan Perangkat,',
      'lalu arahkan kamera ke gambar di atas.',
      '',
      'QR hanya berlaku sekitar 20 detik. Bila kedaluwarsa, bot mengirim yang baru.',
      'Peringatan stok TIDAK diteruskan sampai QR berhasil dipindai.',
    ].join('\n');

    let terkirim = 0;
    for (const id of this.config.telegram.adminIds) {
      try {
        if (png) {
          await this.bot.sendPhoto(id, png, { caption }, { filename: 'whatsapp-qr.png', contentType: 'image/png' });
        } else {
          await this.bot.sendMessage(id, [
            '📲 WHATSAPP MEMINTA SCAN QR',
            '',
            'Gambar QR tidak dapat dibuat di mesin ini, jadi tidak bisa dikirim ke sini.',
            '',
            'Dua jalan keluar:',
            '',
            '1) Pasang pembuat gambar QR sekali saja, lalu jalankan ulang:',
            '     npm install qrcode',
            '',
            '2) Hentikan service, jalankan "npm start" dari terminal, lalu pindai QR',
            '   yang muncul di layar:',
            '     HP → WhatsApp → Setelan → Perangkat Tertaut → Tautkan Perangkat',
            '',
            'Peringatan stok TIDAK diteruskan sampai QR berhasil dipindai.',
          ].join('\n'));
        }
        terkirim += 1;
      } catch (err) {
        logger.warn(`Gagal mengirim QR ke admin ${id}: ${err.message}`);
      }
    }
    if (terkirim > 0) logger.info(`QR WhatsApp dikirim ke ${terkirim} admin lewat Telegram.`);
    return terkirim > 0;
  }

  notifyAdmins(text) {
    if (!this.bot) return;
    for (const id of this.config.telegram.adminIds) {
      this.bot.sendMessage(id, `⚠️ ${text}`).catch(() => { /* admin belum pernah chat bot */ });
    }
  }

  /* ---------------------------- handlers ----------------------------- */
  async onMessage(msg) {
    if (!msg) return;
    const chatId = msg.chat && msg.chat.id;
    const userId = msg.from ? msg.from.id : null;
    const text = msg.text || msg.caption || '';

    // Perintah
    if (typeof text === 'string' && text.startsWith('/')) {
      const handled = await this.onCommand(msg, text);
      if (handled) return;
    }

    // Input bertahap Admin Menu (tambah user, edit template, dll)
    if (userId && this.admin && (await this.admin.handleText(msg))) return;

    // Alur otomatis Telegram -> WhatsApp.
    // Dilewati bila sumber pesan diatur ke mode akun (TELEGRAM_SOURCE=user):
    // pesan dibaca oleh src/telegram-user.js, bot hanya melayani Admin Menu.
    if (!text) return;
    if (!this.config.usesBotSource) return;
    await this.pipeline.handle({
      chatId,
      messageId: msg.message_id,
      text,
      chatTitle: msg.chat && (msg.chat.title || msg.chat.username || ''),
    });
  }

  async onCommand(msg, text) {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : null;
    const cmd = text.split(/[\s@]/)[0].toLowerCase();

    switch (cmd) {
      case '/start':
      case '/help': {
        const isAdmin = this.config.isAdmin(userId);
        await this.bot.sendMessage(chatId, [
          '🤖 TELEGRAM → WHATSAPP BOT',
          '',
          'Bot ini meneruskan peringatan stok dari Telegram ke WhatsApp Group,',
          'lalu mengirim pesan follow-up dengan mention ke user yang terdaftar.',
          '',
          'Perintah:',
          '/id      - tampilkan Chat ID & User ID',
          '/status  - status koneksi bot',
          isAdmin ? '/admin   - buka Admin Menu' : '',
          isAdmin ? '/groups  - atur WhatsApp Group tujuan' : '',
          isAdmin ? '/wadiag  - diagnosa daftar group WhatsApp' : '',
          isAdmin ? '/ocs     - kirim laporan Fulfilment Dashboard sekarang' : '',
          isAdmin ? '/ocsstatus - status penjadwal laporan OCS' : '',
          isAdmin ? '/ocson, /ocsoff - nyalakan / matikan laporan berkala' : '',
          isAdmin ? '/stok    - kirim laporan Stok Menipis sekarang' : '',
          isAdmin ? '/stokstatus - pengaturan & status laporan stok' : '',
          isAdmin ? '/stokon, /stokoff - nyalakan / matikan laporan stok' : '',
          isAdmin ? '/stokjam 8,12,16 - jam kirim laporan stok' : '',
          isAdmin ? '/stokambang 1000 - batas stok yang dianggap menipis' : '',
          isAdmin ? '/stoktop 20 - jumlah SKU yang ditampilkan' : '',
          isAdmin ? '/stokhari 90 - jendela hari untuk rata-rata penjualan' : '',
          isAdmin ? '/stokmode winsor - cara menghitung rata-rata' : '',
          isAdmin ? '/stokgroup - group WhatsApp tujuan laporan stok' : '',
          isAdmin ? '/lock    - periksa & kirim peringatan LOCK STOCK sekarang' : '',
          isAdmin ? '/lockstatus - pengaturan, PIC, dan jadwal berikutnya' : '',
          isAdmin ? '/lockon, /lockoff - nyalakan / matikan pemeriksaan berkala' : '',
          isAdmin ? '/lockpic <Shop> <Nama> - nama PIC tiap shop' : '',
          isAdmin ? '/lockwa <Shop> <Nomor> - nomor PIC agar di-mention sungguhan' : '',
          isAdmin ? '/lockjeda 60 7 - jeda menit + penyimpangan acak' : '',
          isAdmin ? '/lockgroup - group WhatsApp tujuan peringatan lock' : '',
          isAdmin ? '/lockulang on|off - ulangi pesan yang sama tiap jam?' : '',
          '',
          isAdmin ? '' : 'Anda bukan administrator bot ini.',
        ].filter(Boolean).join('\n'));
        return true;
      }

      case '/id': {
        await this.bot.sendMessage(chatId, [
          '🆔 INFORMASI ID',
          '',
          `Chat ID : ${chatId}`,
          `Chat Type: ${msg.chat.type}`,
          userId ? `User ID : ${userId}` : '',
          '',
          'Isikan Chat ID ke TELEGRAM_ALLOWED_CHAT_IDS',
          'dan User ID ke ADMIN_TELEGRAM_IDS di file .env,',
          'lalu restart aplikasi.',
        ].filter(Boolean).join('\n'));
        return true;
      }

      case '/status': {
        if (!this.config.isAdmin(userId)) {
          await this.bot.sendMessage(chatId, require('./admin').DENIED);
          return true;
        }
        const v = this.admin.statusView();
        await this.bot.sendMessage(chatId, v.text, { reply_markup: { inline_keyboard: v.keyboard } });
        return true;
      }

      case '/admin': {
        if (!this.config.isAdmin(userId)) {
          logger.warn(`Percobaan akses /admin oleh user ${userId} ditolak`);
          await this.bot.sendMessage(chatId, require('./admin').DENIED);
          return true;
        }
        await this.admin.showMain(chatId);
        return true;
      }

      case '/groups': {
        if (!this.config.isAdmin(userId)) {
          await this.bot.sendMessage(chatId, require('./admin').DENIED);
          return true;
        }
        const v = this.admin.groupsView();
        await this.bot.sendMessage(chatId, v.text, { reply_markup: { inline_keyboard: v.keyboard } });
        return true;
      }

      case '/wadiag': {
        if (!this.config.isAdmin(userId)) {
          await this.bot.sendMessage(chatId, require('./admin').DENIED);
          return true;
        }
        await this.bot.sendMessage(chatId, '🩺 Memeriksa halaman WhatsApp Web...');
        const v = await this.admin.waDiagView();
        await this.bot.sendMessage(chatId, v.text, { reply_markup: { inline_keyboard: v.keyboard } });
        return true;
      }

      case '/keyword': {
        if (!this.config.isAdmin(userId)) return true;
        await this.bot.sendMessage(chatId, `🔎 Keyword filter:\n"${KEYWORD}"\n\n(case-insensitive, satu-satunya pemicu forwarding)`);
        return true;
      }

      case '/ocs': {
        if (!this.config.isAdmin(userId)) {
          await this.bot.sendMessage(chatId, require('./admin').DENIED);
          return true;
        }
        if (!this.ocs) {
          await this.bot.sendMessage(chatId, 'Laporan OCS tidak aktif. Isi OCS_ENABLED=true di file .env lalu jalankan ulang aplikasi.');
          return true;
        }
        await this.bot.sendMessage(chatId, 'Mengambil data dari OCS...');
        const hasil = await this.ocs.runOnce({ paksa: true });
        if (hasil.status === 'sent') {
          await this.bot.sendMessage(chatId, `Laporan terkirim ke ${hasil.groups} group WhatsApp.\n\n${hasil.text}`);
        } else if (hasil.text) {
          await this.bot.sendMessage(chatId, `Tidak dikirim (${hasil.reason}). Isi laporan saat ini:\n\n${hasil.text}`);
        } else {
          await this.bot.sendMessage(chatId, `Laporan tidak dikirim - ${hasil.reason || hasil.status}`);
        }
        return true;
      }

      case '/ocsstatus': {
        if (!this.config.isAdmin(userId)) {
          await this.bot.sendMessage(chatId, require('./admin').DENIED);
          return true;
        }
        if (!this.ocs) {
          await this.bot.sendMessage(chatId, 'Laporan OCS tidak aktif (OCS_ENABLED belum true).');
          return true;
        }
        await this.bot.sendMessage(chatId, this.ocs.ringkasanStatus());
        return true;
      }

      case '/ocson':
      case '/ocsoff': {
        if (!this.config.isAdmin(userId)) {
          await this.bot.sendMessage(chatId, require('./admin').DENIED);
          return true;
        }
        if (!this.ocs) {
          await this.bot.sendMessage(chatId, 'Laporan OCS tidak aktif (OCS_ENABLED belum true).');
          return true;
        }
        const nyalakan = cmd === '/ocson';
        this.ocs.setEnabled(nyalakan);
        await this.bot.sendMessage(chatId, nyalakan
          ? 'Laporan OCS DIAKTIFKAN. Pesan berikutnya dikirim sesuai jadwal.'
          : 'Laporan OCS DIMATIKAN. Pakai /ocs untuk mengirim sekali secara manual.');
        return true;
      }

      /* ----------------------- laporan Stok Menipis ---------------------- */

      case '/stok':
      case '/stokstatus':
      case '/stokon':
      case '/stokoff':
      case '/stokjam':
      case '/stokambang':
      case '/stoktop':
      case '/stokhari':
      case '/stokmode':
      case '/stokgroup': {
        if (!this.config.isAdmin(userId)) {
          await this.bot.sendMessage(chatId, require('./admin').DENIED);
          return true;
        }
        if (!this.stock) {
          await this.bot.sendMessage(chatId,
            'Laporan stok tidak aktif. Isi STOCK_ENABLED=true di file .env lalu jalankan ulang aplikasi.');
          return true;
        }
        // Semua kata setelah nama perintah adalah nilainya.
        const nilai = text.slice(cmd.length).replace(/^@\S+/, '').trim();

        if (cmd === '/stok') {
          await this.bot.sendMessage(chatId, 'Mengambil data stok & penjualan dari OCS. Ini bisa satu menit...');
          const hasil = await this.stock.runOnce({ paksa: true });
          if (hasil.status === 'sent') {
            await this.bot.sendMessage(chatId, `Laporan stok terkirim ke ${hasil.groups} group WhatsApp.\n\n${hasil.text}`);
          } else if (hasil.text) {
            await this.bot.sendMessage(chatId, `Tidak dikirim (${hasil.reason}). Isi laporan saat ini:\n\n${hasil.text}`);
          } else {
            await this.bot.sendMessage(chatId, `Laporan stok tidak dikirim - ${hasil.reason || hasil.status}`);
          }
          return true;
        }

        if (cmd === '/stokstatus') {
          await this.bot.sendMessage(chatId, this.stock.ringkasanStatus());
          return true;
        }

        if (cmd === '/stokon' || cmd === '/stokoff') {
          const nyalakan = cmd === '/stokon';
          this.stock.setEnabled(nyalakan);
          await this.bot.sendMessage(chatId, nyalakan
            ? 'Laporan stok DIAKTIFKAN. Terkirim otomatis pada jam yang disetel (/stokjam).'
            : 'Laporan stok DIMATIKAN. Pakai /stok untuk mengirim sekali secara manual.');
          return true;
        }

        const peta = {
          '/stokjam': ['hours', 'Contoh: /stokjam 8,12,16'],
          '/stokambang': ['ambang', 'Contoh: /stokambang 1000'],
          '/stoktop': ['top', 'Contoh: /stoktop 20'],
          '/stokhari': ['salesDays', 'Contoh: /stokhari 90'],
          '/stokmode': ['avgMode', 'Pilihan: winsor (bawaan), full, normal, median'],
          '/stokgroup': ['groups', 'Contoh: /stokgroup 12036...@g.us  |  kosongkan untuk semua group aktif'],
        };
        const [nama, contoh] = peta[cmd];
        if (!nilai && cmd !== '/stokgroup') {
          await this.bot.sendMessage(chatId, `Nilainya belum diisi.\n${contoh}`);
          return true;
        }
        try {
          const pesan = this.stock.setOpsi(nama, nilai);
          await this.bot.sendMessage(chatId, `Tersimpan. ${pesan}`);
        } catch (err) {
          await this.bot.sendMessage(chatId, `Gagal: ${err.message}\n${contoh}`);
        }
        return true;
      }

      /* ---------------------- peringatan LOCK STOCK ---------------------- */

      case '/lock':
      case '/lockstatus':
      case '/lockon':
      case '/lockoff':
      case '/lockpic':
      case '/lockwa':
      case '/lockjeda':
      case '/lockgroup':
      case '/lockulang': {
        if (!this.config.isAdmin(userId)) {
          await this.bot.sendMessage(chatId, require('./admin').DENIED);
          return true;
        }
        if (!this.lock) {
          await this.bot.sendMessage(chatId,
            'Peringatan lock stock tidak aktif. Isi LOCK_ENABLED=true di file .env lalu jalankan ulang aplikasi.');
          return true;
        }
        const arg = text.slice(cmd.length).replace(/^@\S+/, '').trim();

        if (cmd === '/lock') {
          await this.bot.sendMessage(chatId, 'Memeriksa lock stock di OCS...');
          const hasil = await this.lock.runOnce({ paksa: true });
          if (hasil.status === 'sent') {
            const isi = hasil.pesan.map((p) => p.text).join('\n\n- - - - -\n\n');
            await this.bot.sendMessage(chatId,
              `Terkirim ${hasil.alerts} pesan ke ${hasil.groups} group (${hasil.ringkasan}).\n\n${isi}`);
          } else if (hasil.status === 'clear') {
            await this.bot.sendMessage(chatId, 'Aman - tidak ada SKU dengan reserve melebihi stok tersedia.');
          } else {
            await this.bot.sendMessage(chatId, `Tidak dikirim - ${hasil.reason || hasil.status}`);
          }
          return true;
        }

        if (cmd === '/lockstatus') {
          await this.bot.sendMessage(chatId, this.lock.ringkasanStatus());
          return true;
        }

        if (cmd === '/lockon' || cmd === '/lockoff') {
          const nyalakan = cmd === '/lockon';
          this.lock.setEnabled(nyalakan);
          await this.bot.sendMessage(chatId, nyalakan
            ? 'Peringatan lock stock DIAKTIFKAN. Pemeriksaan berjalan sesuai jeda yang disetel.'
            : 'Peringatan lock stock DIMATIKAN. Pakai /lock untuk memeriksa sekali secara manual.');
          return true;
        }

        try {
          if (cmd === '/lockpic' || cmd === '/lockwa') {
            const pisah = arg.split(/\s+/);
            const shop = pisah.shift();
            const sisa = pisah.join(' ').trim();
            if (!shop) {
              await this.bot.sendMessage(chatId, cmd === '/lockpic'
                ? 'Contoh: /lockpic NCO Ibu Manda'
                : 'Contoh: /lockwa NCO 6281234567890  (tulis "hapus" untuk membuang nomornya)');
              return true;
            }
            const pesan = cmd === '/lockpic'
              ? this.lock.setPicNama(shop, sisa)
              : this.lock.setPicNomor(shop, sisa);
            await this.bot.sendMessage(chatId, `Tersimpan. ${pesan}`);
            return true;
          }

          if (cmd === '/lockjeda') {
            const [a, b] = arg.split(/\s+/);
            if (!a) {
              await this.bot.sendMessage(chatId, 'Contoh: /lockjeda 60 7  (tiap 60 menit, digeser acak +/- 7 menit)');
              return true;
            }
            const p1 = this.lock.setOpsi('interval', a);
            const p2 = b !== undefined ? this.lock.setOpsi('jitter', b) : null;
            await this.bot.sendMessage(chatId, `Tersimpan. ${p1}${p2 ? `\n${p2}` : ''}`
              + '\n\nBerlaku pada pemeriksaan berikutnya.');
            return true;
          }

          if (cmd === '/lockgroup') {
            await this.bot.sendMessage(chatId, `Tersimpan. ${this.lock.setOpsi('groups', arg)}`);
            return true;
          }

          if (cmd === '/lockulang') {
            // "/lockulang on" = ulangi tiap jam; "off" = hanya bila berubah.
            const on = /^(on|ya|1|true)$/i.test(arg);
            await this.bot.sendMessage(chatId, `Tersimpan. ${this.lock.setOpsi('onlyOnChange', on ? '0' : '1')}`);
            return true;
          }
        } catch (err) {
          await this.bot.sendMessage(chatId, `Gagal: ${err.message}`);
          return true;
        }
        return true;
      }

      case '/batal':
      case '/cancel':
        return false; // ditangani oleh admin.handleText

      default:
        return false;
    }
  }

  async onCallback(query) {
    if (!query || !query.data) return;
    if (String(query.data).startsWith('tc:')) return this.admin.handleTemplateConfirm(query);
    return this.admin.handleCallback(query);
  }
}

module.exports = TelegramService;
