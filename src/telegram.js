'use strict';

const logger = require('./logger').scope('TG');
const tujuan = require('./tujuan');

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

        // Bantuan dikelompokkan per "bot": tiap kelompok berdiri sendiri,
        // punya tombol on/off dan group tujuan sendiri, sehingga satu
        // kelompok bisa dimatikan tanpa mengganggu yang lain.
        // Baris kosong di sini SENGAJA - jangan pakai .filter(Boolean) saat
        // menggabungkan, karena itu ikut membuang pemisah antar kelompok
        // dan seluruh bantuan menempel jadi satu blok.
        const umum = [
          '*BOT GUDANG - IEG*',
          '',
          'Empat bot berdiri sendiri di dalam satu aplikasi.',
          'Masing-masing punya tombol on/off dan group tujuan sendiri.',
          '',
          '*UMUM*',
          '/id      - tampilkan Chat ID & User ID',
          '/status  - status koneksi bot',
          ...(isAdmin ? [
            '/admin   - buka Admin Menu',
            '/groups  - daftar & aktifkan WhatsApp Group',
            '/tujuan  - group tujuan tiap jalur (cek SAMA / BEDA)',
            '/wadiag  - diagnosa daftar group WhatsApp',
          ] : []),
        ];

        const forwarder = [
          '',
          '*1. FORWARDER TELEGRAM -> WHATSAPP*',
          '_Meneruskan data pesanan dari grup Telegram apa adanya,_',
          '_dengan mention PIC ditempel di pesan yang sama. Tanpa tunda._',
          '/keyword          - lihat / ganti pemicu forwarding',
          '/mention gabung|pisah|mati - cara mention dikirim',
          '/tagall on|off    - sentil SELURUH anggota group, bukan hanya user terdaftar',
          'Tombol on/off & template: /admin > Pengaturan',
          'Group tujuan: group yang AKTIF di /groups,',
          'dikurangi group tujuan Peringatan Lock Stock (lihat /tujuan)',
        ];

        const fulfilment = [
          '',
          '*2. LAPORAN FULFILMENT DASHBOARD*',
          '_Ringkasan SLA, WIP, throughput, dan peringkat operator dari OCS._',
          '/ocs       - kirim laporan sekarang',
          '/ocsstatus - jadwal & status',
          '/ocson, /ocsoff - nyalakan / matikan laporan berkala',
        ];

        const stok = [
          '',
          '*3. LAPORAN STOK MENIPIS*',
          '_SKU di bawah ambang, lengkap dengan rata-rata penjualan harian_',
          '_dan perkiraan stok cukup untuk berapa hari lagi._',
          '/stok       - kirim laporan sekarang',
          '/stokstatus - pengaturan & status',
          '/stokon, /stokoff - nyalakan / matikan laporan',
          '/stokjam 8,12,16  - jam kirim',
          '/stokdoi 7        - tampilkan SKU yang stoknya cukup < 7 hari',
          '/stokambang 0     - batas jumlah stok (0 = tanpa batas)',
          '/stokminavg 0     - abaikan SKU yang lakunya di bawah sekian/hari',
          '/stokpic <Nama>   - PIC laporan stok (boleh >1, pisah koma)',
          '/stokwa <Nomor>   - nomor PIC agar di-mention (urut, pisah koma)',
          '/stoktop 20       - jumlah SKU yang ditampilkan',
          '/stokhari 90      - jendela hari untuk rata-rata penjualan',
          '/stokmode winsor  - cara menghitung rata-rata',
          '/stokgroup        - group WhatsApp tujuan',
        ];

        const lock = [
          '',
          '*4. PERINGATAN LOCK STOCK*',
          '_SKU yang stok ter-reserve-nya melebihi stok tersedia._',
          '_Satu pesan per Shop, disapa ke PIC masing-masing._',
          '/lock       - periksa & kirim sekarang',
          '/lockstatus - pengaturan, PIC, jadwal berikutnya',
          '/lockon, /lockoff - nyalakan / matikan pemeriksaan',
          '/lockpic <Shop> <Nama>  - PIC tiap shop (boleh >1, pisah koma)',
          '/lockwa <Shop> <Nomor>  - nomor PIC agar di-mention (urut, pisah koma)',
          '/lockjeda 60 7    - jeda menit + penyimpangan acak',
          '/lockgroup        - group tujuan (WAJIB, terpisah dari Forwarder)',
          '/tujuan           - bandingkan dengan group Forwarder',
          '/lockulang on|off - ulangi pesan yang sama tiap jam?',
        ];

        const kaki = isAdmin
          ? ['', '_Uji tanpa mengirim ke WhatsApp:_',
             '_npm run ocs:test | stock:test | lock:test_']
          : ['', 'Anda bukan administrator bot ini.'];

        const baris = isAdmin
          ? [...umum, ...forwarder, ...fulfilment, ...stok, ...lock, ...kaki]
          : [...umum, ...kaki];

        await this.bot.sendMessage(chatId, baris.join('\n'), { parse_mode: 'Markdown' });
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
        const argKw = text.slice(cmd.length).replace(/^@\S+/, '').trim();
        const aktif = this.pipeline.keywordAktif();

        if (!argKw) {
          await this.bot.sendMessage(chatId, [
            '🔎 PEMICU FORWARDING',
            '',
            aktif
              ? `Sekarang: "${aktif}"`
              : 'Sekarang: TANPA SARINGAN - semua pesan diteruskan.',
            '(pencocokan mengabaikan besar-kecil huruf, newline, dan emoji)',
            '',
            'Ganti:',
            '  /keyword PAKET INSTANT',
            '',
            'Teruskan semua pesan tanpa saringan kata:',
            '  /keyword semua',
          ].join('\n'));
          return true;
        }

        // Mengosongkan saringan harus disengaja - tidak bisa lewat argumen kosong.
        const baru = /^(semua|all|kosong)$/i.test(argKw) ? '' : argKw;
        this.db.setSetting('forward_keyword', baru);
        await this.bot.sendMessage(chatId, baru
          ? `Tersimpan. Pemicu forwarding sekarang: "${baru}"\n\nBerlaku untuk pesan berikutnya, tanpa restart.`
          : 'Tersimpan. Saringan kata DIMATIKAN - SELURUH pesan dari chat yang '
            + 'diizinkan akan diteruskan ke WhatsApp, termasuk obrolan biasa.');
        return true;
      }

      case '/mention': {
        if (!this.config.isAdmin(userId)) return true;
        const argM = text.slice(cmd.length).replace(/^@\S+/, '').trim().toLowerCase();
        if (!['gabung', 'pisah', 'mati'].includes(argM)) {
          await this.bot.sendMessage(chatId, [
            '🏷️ CARA MENGIRIM MENTION',
            '',
            `Sekarang: ${this.pipeline.modeMention()}`,
            '',
            '/mention gabung - mention ditempel di bawah teks pesanan (1 pesan)',
            '/mention pisah  - mention dikirim sebagai pesan kedua',
            '/mention mati   - tanpa mention sama sekali',
          ].join('\n'));
          return true;
        }
        this.db.setSetting('mention_mode', argM);
        await this.bot.sendMessage(chatId, `Tersimpan. Mode mention: ${argM}.`);
        return true;
      }

      case '/tagall': {
        if (!this.config.isAdmin(userId)) return true;
        const argT = text.slice(cmd.length).replace(/^@\S+/, '').trim().toLowerCase();
        const sedang = this.pipeline.tagSemuaAktif();
        if (!/^(on|off|nyala|mati|1|0|ya|tidak)$/i.test(argT)) {
          await this.bot.sendMessage(chatId, [
            '🔔 TAG SEMUA ANGGOTA GROUP',
            '',
            `Sekarang: ${sedang ? 'NYALA' : 'MATI'}`,
            '',
            sedang
              ? 'Setiap pesan forwarder menyentil SELURUH anggota group tujuan,'
              : 'Pesan forwarder hanya menyentil user yang terdaftar di Admin Menu,',
            sedang
              ? 'bukan hanya user yang terdaftar di Admin Menu.'
              : 'yaitu yang menggantikan {users} di template.',
            '',
            'Teks pesan TIDAK berubah. Nomor semua anggota dikirim diam-diam,',
            'jadi WhatsApp tetap memberi notifikasi ke semua orang tanpa',
            'pesannya berubah menjadi deretan angka sepanjang layar.',
            '',
            '/tagall on  - sentil semua anggota group',
            '/tagall off - hanya user terdaftar',
            '',
            'Ingin nomornya IKUT TERLIHAT? Pakai {all} di dalam template',
            '(/admin > Template Pesan), bukan perintah ini.',
          ].join('\n'));
          return true;
        }
        const nyala = /^(on|nyala|1|ya)$/i.test(argT);
        this.db.setSetting('mention_all', nyala ? '1' : '0');
        this.pipeline.lupakanAnggota();
        await this.bot.sendMessage(chatId, nyala
          ? 'Tersimpan. Setiap pesan forwarder sekarang menyentil SELURUH anggota '
            + 'group tujuan.\n\nBerlaku untuk pesan berikutnya, tanpa restart.'
          : 'Tersimpan. Pesan forwarder kembali hanya menyentil user terdaftar '
            + '({users} di template).');
        return true;
      }

      case '/tujuan': {
        if (!this.config.isAdmin(userId)) return true;
        const argJ = text.slice(cmd.length).replace(/^@\S+/, '').trim().toLowerCase();

        if (/^(pisah|pisahkan)$/i.test(argJ)) {
          const hasil = tujuan.pisahkanOtomatis(this.db, this.config);
          if (hasil.dipisah.length > 0) {
            const nama = hasil.dipisah.map((g) => g.name).join(', ');
            logger.info(`Group "${nama}" dinonaktifkan dari forwarder oleh admin ${userId} lewat /tujuan pisah`);
            if (this.pipeline) this.pipeline.lupakanAnggota();
            await this.bot.sendMessage(chatId,
              `Selesai. Group "${nama}" dinonaktifkan di /groups, jadi Forwarder `
              + 'Telegram berhenti mengirim ke sana. Peringatan lock stock tetap ke group itu.\n\n'
              + tujuan.ringkasan(this.db, this.config));
            return true;
          }
          if (hasil.tidakBisaDipisah) {
            await this.bot.sendMessage(chatId,
              'Tidak dipisah: itu satu-satunya group aktif, jadi memisahkannya '
              + 'akan membuat forward pesanan berhenti total.\n\n'
              + 'Pindahkan peringatan lock stock ke group lain dengan /lockgroup, '
              + 'atau tambah group baru di /groups lebih dulu.');
            return true;
          }
          await this.bot.sendMessage(chatId, 'Tidak ada yang perlu dipisah - kedua jalur sudah berbeda group.');
          return true;
        }

        await this.bot.sendMessage(chatId, tujuan.ringkasan(this.db, this.config)
          + '\n\nPisahkan otomatis: /tujuan pisah');
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
      case '/stokdoi':
      case '/stokminavg':
      case '/stokpic':
      case '/stokwa':
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

        if (cmd === '/stokpic' || cmd === '/stokwa') {
          try {
            const pesan = cmd === '/stokpic'
              ? this.stock.setPicNama(nilai)
              : this.stock.setPicNomor(nilai);
            await this.bot.sendMessage(chatId, `Tersimpan. ${pesan}`);
          } catch (err) {
            await this.bot.sendMessage(chatId, `Gagal: ${err.message}\n\n`
              + (cmd === '/stokpic'
                ? 'Contoh: /stokpic Ibu Ani, Bpk. Budi\nKosongkan untuk membuang sapaan.'
                : 'Contoh: /stokwa 6281234567890, 6289876543210\n'
                  + 'Urut sesuai nama di /stokpic. "kosong" untuk melewati satu orang.'));
          }
          return true;
        }

        const peta = {
          '/stokjam': ['hours', 'Contoh: /stokjam 8,12,16'],
          '/stokdoi': ['doiMax', 'Contoh: /stokdoi 7  (0 = matikan saringan DOI)'],
          '/stokminavg': ['minAvg', 'Contoh: /stokminavg 1  (0 = tampilkan semua)'],
          '/stokambang': ['ambang', 'Contoh: /stokambang 0  (0 = tanpa batas jumlah)'],
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
                ? 'Contoh satu PIC   : /lockpic NCO Ibu Manda\n'
                  + 'Contoh dua PIC    : /lockpic NCO Ibu Manda, Bpk. Andi\n\n'
                  + 'Perintah ini mengganti SELURUH daftar PIC shop tersebut.'
                : 'Contoh satu nomor : /lockwa NCO 6281234567890\n'
                  + 'Contoh dua nomor  : /lockwa NCO 6281234567890, 6289876543210\n\n'
                  + 'Nomor dipasangkan URUT dengan nama di /lockpic.\n'
                  + 'Tulis "kosong" untuk melewati satu orang, contoh: 62811, kosong, 62833\n'
                  + 'Tulis "hapus" untuk membuang semua nomor di shop itu.');
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
            // Argumen kosong DULU langsung mengosongkan setelan - terlalu mudah
            // tidak sengaja mematikan peringatan. Sekarang kosong = tampilkan
            // bantuan; mengosongkan harus disengaja dengan kata "hapus".
            if (!arg) {
              const sekarang = this.lock.opsi().groupIds;
              await this.bot.sendMessage(chatId, [
                '📌 GROUP TUJUAN PERINGATAN LOCK STOCK',
                '',
                sekarang.length
                  ? `Sekarang: ${sekarang.join(', ')}`
                  : 'Sekarang: BELUM DISETEL - peringatan tidak akan terkirim.',
                '',
                'Cara isi (pilih salah satu):',
                '  /lockgroup https://chat.whatsapp.com/AbCdEf123456',
                '  /lockgroup 120363011111111111@g.us',
                '  /lockgroup Nama Group Lock Stock',
                '',
                'Link undangan otomatis diterjemahkan jadi JID, dan groupnya',
                'didaftarkan TIDAK AKTIF supaya Forwarder tidak ikut mengirim.',
                'Syaratnya bot sudah menjadi ANGGOTA group tersebut.',
                'Daftar group beserta JID-nya ada di /groups.',
                'Group ini HARUS berbeda dari group Forwarder Telegram.',
                '',
                'Untuk mengosongkan dengan sengaja: /lockgroup hapus',
              ].join('\n'));
              return true;
            }
            if (/^(hapus|kosong|kosongkan|clear)$/i.test(arg)) {
              await this.bot.sendMessage(chatId, `Tersimpan. ${this.lock.setOpsi('groups', '')}`);
              return true;
            }

            // Link undangan WhatsApp bukan JID - dulu ditolak mentah-mentah
            // walau itu yang paling mudah disalin dari HP. Sekarang link
            // diterjemahkan dulu menjadi JID, dan groupnya didaftarkan
            // sebagai TIDAK AKTIF supaya Forwarder tidak ikut mengirim ke sana.
            if (/^(https?:\/\/)?chat\.whatsapp\.com\//i.test(arg)) {
              if (!this.wa || !this.wa.isReady()) {
                await this.bot.sendMessage(chatId,
                  'WhatsApp belum siap, link undangan belum bisa diterjemahkan. '
                  + 'Coba lagi setelah status WhatsApp "ready", atau isi JID-nya langsung.');
                return true;
              }
              await this.bot.sendMessage(chatId, 'Menerjemahkan link undangan...');
              let info;
              try {
                info = await this.wa.resolveInvite(arg);
              } catch (err) {
                await this.bot.sendMessage(chatId,
                  `Link undangan tidak bisa dibaca: ${err.message}\n\n`
                  + 'Pastikan bot sudah menjadi ANGGOTA group tersebut. '
                  + 'Link undangan saja tidak membuat bot bergabung.');
                return true;
              }

              const sudahAda = this.db.getWaGroupByGid(info.id);
              if (!sudahAda) {
                const baru = this.db.addWaGroup(info.id, info.name);
                // addWaGroup selalu mengaktifkan; group lock stock harus PASIF
                // agar tidak ikut menerima forward dari Telegram.
                this.db.updateWaGroup(baru.id, { active: 0 });
              }
              const pesan = this.lock.setOpsi('groups', info.id);
              let catatan = '\n\nGroup didaftarkan sebagai TIDAK AKTIF di /groups, '
                + 'jadi Forwarder Telegram tidak ikut mengirim ke sana.';
              if (sudahAda && sudahAda.active) {
                // Group lama yang sedang aktif: pisahkan sekarang juga.
                const hp = tujuan.pisahkanOtomatis(this.db, this.config);
                if (this.pipeline) this.pipeline.lupakanAnggota();
                catatan = hp.dipisah.length > 0
                  ? '\n\nGroup ini otomatis DINONAKTIFKAN di /groups, jadi Forwarder '
                    + 'Telegram berhenti mengirim ke sana.'
                  : '\n\nPERHATIAN: group ini satu-satunya group AKTIF di /groups, jadi '
                    + 'Forwarder Telegram masih ikut mengirim ke sana. Tambah group lain '
                    + 'di /groups, atau pindahkan lock stock ke group lain.';
              }
              await this.bot.sendMessage(chatId,
                `Tersimpan. ${pesan}\nNama group: ${info.name}${catatan}`);
              return true;
            }

            const pesanSimpan = this.lock.setOpsi('groups', arg);
            // Menyetel tujuan lock stock ke group yang JUGA aktif untuk
            // Forwarder tidak memisahkan apa pun - dua jalur tetap menumpuk
            // di ruang yang sama. Pemisahannya dikerjakan di sini, di tempat
            // pilihannya dibuat, bukan diserahkan ke admin untuk diingat.
            const hasilPisah = tujuan.pisahkanOtomatis(this.db, this.config);
            let catatanPisah = '';
            if (hasilPisah.dipisah.length > 0) {
              const nama = hasilPisah.dipisah.map((g) => g.name).join(', ');
              logger.info(`Group "${nama}" dinonaktifkan dari forwarder karena dijadikan tujuan lock stock`);
              if (this.pipeline) this.pipeline.lupakanAnggota();
              catatanPisah = `\n\nGroup "${nama}" otomatis DINONAKTIFKAN di /groups, `
                + 'jadi Forwarder Telegram tidak ikut mengirim ke sana.';
            } else if (hasilPisah.tidakBisaDipisah) {
              catatanPisah = '\n\nPERHATIAN: group ini satu-satunya group AKTIF di /groups, '
                + 'jadi Forwarder Telegram masih ikut mengirim ke sana. Tidak dinonaktifkan '
                + 'otomatis karena itu akan menghentikan forward pesanan sama sekali. '
                + 'Tambah group lain di /groups, atau pindahkan lock stock ke group lain.';
            }
            await this.bot.sendMessage(chatId, `Tersimpan. ${pesanSimpan}${catatanPisah}`);
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
