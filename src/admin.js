'use strict';

const logger = require('./logger').scope('ADMIN');
const { validateWhatsappNumber, renderTemplate, renderPreviewForTelegram } = require('./render');
const { KEYWORD } = require('./filter');

const STATE_TTL_MS = 10 * 60 * 1000; // 10 menit

const DENIED = '⛔ Access Denied\n\nAnda tidak memiliki akses administrator.';

function fmtUptime(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}h ${h}j ${m}m`;
  if (h > 0) return `${h}j ${m}m`;
  return `${m}m`;
}

function maskNumber(num) {
  const s = String(num || '');
  if (s.length <= 5) return s;
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(0, s.length - 7))}${s.slice(-3)}`;
}

/**
 * Admin Menu berbasis Telegram Inline Keyboard.
 * SETIAP callback diperiksa otorisasinya di sisi server - menyembunyikan
 * tombol saja tidak dianggap cukup.
 */
class AdminMenu {
  constructor({ bot, db, whatsapp, queue, config, pipeline, startedAt }) {
    this.bot = bot;
    this.db = db;
    this.wa = whatsapp;
    this.queue = queue;
    this.config = config;
    this.pipeline = pipeline;
    this.startedAt = startedAt || Date.now();
    this.userSource = null;    // diisi index.js bila TELEGRAM_SOURCE memakai akun
    this.states = new Map();   // `${chatId}:${userId}` -> {action, data, expiresAt}
    this.groupCache = [];      // hasil /groups terakhir (untuk callback pendek)
  }

  /* --------------------------- otorisasi ---------------------------- */
  isAdmin(userId) {
    return this.config.isAdmin(userId);
  }

  async denyCallback(query) {
    await this._answer(query.id, '⛔ Access Denied', true);
    try {
      await this.bot.sendMessage(query.message.chat.id, DENIED);
    } catch (e) { /* ignore */ }
    logger.warn(`Akses admin ditolak untuk user ${query.from && query.from.id}`);
  }

  /* ------------------------------ state ------------------------------ */
  _key(chatId, userId) { return `${chatId}:${userId}`; }

  setState(chatId, userId, action, data = {}) {
    this.states.set(this._key(chatId, userId), { action, data, expiresAt: Date.now() + STATE_TTL_MS });
  }

  getState(chatId, userId) {
    const k = this._key(chatId, userId);
    const st = this.states.get(k);
    if (!st) return null;
    if (st.expiresAt < Date.now()) { this.states.delete(k); return null; }
    return st;
  }

  clearState(chatId, userId) { this.states.delete(this._key(chatId, userId)); }

  /* ---------------------------- helpers ------------------------------ */
  async _answer(id, text = '', alert = false) {
    try { await this.bot.answerCallbackQuery(id, { text, show_alert: alert }); } catch (e) { /* ignore */ }
  }

  async _send(chatId, text, keyboard) {
    return this.bot.sendMessage(chatId, text, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});
  }

  async _edit(query, text, keyboard) {
    try {
      return await this.bot.editMessageText(text, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      });
    } catch (err) {
      // Telegram menolak edit bila isi identik - abaikan saja
      if (String(err.message).includes('message is not modified')) return null;
      return this._send(query.message.chat.id, text, keyboard);
    }
  }

  /* ============================ MENU UTAMA ============================ */
  mainMenuText() {
    return [
      '🤖 TELEGRAM → WHATSAPP BOT',
      '⚙️ ADMIN MENU',
      '',
      'Pilih menu di bawah ini.',
    ].join('\n');
  }

  mainMenuKeyboard() {
    return [
      [{ text: '👥 Kelola User', callback_data: 'm:users' }, { text: '📝 Template Pesan', callback_data: 'm:tpl' }],
      [{ text: '📱 WhatsApp Group', callback_data: 'm:grp' }, { text: '📊 Status Bot', callback_data: 'm:status' }],
      [{ text: '🧪 Test', callback_data: 'm:test' }, { text: '⚙️ Pengaturan', callback_data: 'm:set' }],
    ];
  }

  async showMain(chatId) {
    return this._send(chatId, this.mainMenuText(), this.mainMenuKeyboard());
  }

  /* ============================ KELOLA USER =========================== */
  usersView() {
    const users = this.db.listUsers();
    const lines = ['👥 KELOLA USER', ''];
    if (users.length === 0) {
      lines.push('Belum ada user terdaftar.');
      lines.push('Tekan "➕ Tambah User" untuk menambahkan.');
    } else {
      for (const u of users) {
        lines.push(`${u.active ? '🟢' : '⚪'} ${u.name}`);
        lines.push(`   ${u.whatsapp_number}`);
        lines.push(`   Status: ${u.active ? 'ACTIVE' : 'INACTIVE'}`);
        lines.push('');
      }
      const activeCount = users.filter((u) => u.active).length;
      lines.push(`Total: ${users.length} user, ${activeCount} aktif (yang di-mention).`);
    }

    const keyboard = users.map((u) => ([
      { text: `✏️ ${u.name}`.slice(0, 30), callback_data: `u:e:${u.id}` },
      { text: '🗑️', callback_data: `u:d:${u.id}` },
    ]));
    keyboard.push([{ text: '➕ Tambah User', callback_data: 'u:add' }]);
    keyboard.push([{ text: '⬅️ Kembali', callback_data: 'm:main' }]);
    return { text: lines.join('\n'), keyboard };
  }

  userDetailView(user) {
    const text = [
      '👤 EDIT USER',
      '',
      'Nama:',
      user.name,
      '',
      'Nomor:',
      user.whatsapp_number,
      '',
      `Status: ${user.active ? 'ACTIVE 🟢' : 'INACTIVE ⚪'}`,
      '',
      'Perubahan langsung tersimpan.',
    ].join('\n');
    const keyboard = [
      [{ text: '✏️ Ubah Nama', callback_data: `u:n:${user.id}` }, { text: '📱 Ubah Nomor', callback_data: `u:p:${user.id}` }],
      [{ text: user.active ? '🔘 Jadikan INACTIVE' : '🔘 Jadikan ACTIVE', callback_data: `u:t:${user.id}` }],
      [{ text: '💾 Selesai', callback_data: 'm:users' }, { text: '🗑️ Hapus', callback_data: `u:d:${user.id}` }],
    ];
    return { text, keyboard };
  }

  /* ============================== TEMPLATE ============================ */
  templatesView() {
    const templates = this.db.listTemplates();
    const lines = ['📝 TEMPLATE PESAN', ''];
    const keyboard = [];
    for (const t of templates) {
      lines.push(`${t.active ? '🟢' : '⚪'} ${t.name}`);
      lines.push('');
      lines.push(t.content);
      lines.push('');
      lines.push('──────────');
      keyboard.push([
        { text: '✏️ Edit', callback_data: `t:e:${t.id}` },
        { text: '👀 Preview', callback_data: `t:p:${t.id}` },
        { text: '🧪 Test', callback_data: `t:x:${t.id}` },
        { text: '🔄 Reset', callback_data: `t:r:${t.id}` },
      ]);
    }
    lines.push('');
    lines.push('Placeholder: {users} {datetime} {date} {time}');
    keyboard.push([{ text: '⬅️ Kembali', callback_data: 'm:main' }]);
    return { text: lines.join('\n'), keyboard };
  }

  /* ============================ GROUP WA ============================== */
  /**
   * Daftar group tujuan. Pesan dikirim ke SEMUA group yang berstatus aktif.
   */
  groupsView() {
    const groups = this.db.listWaGroups();
    const aktif = groups.filter((g) => g.active);
    const lines = ['📱 WHATSAPP GROUP', ''];

    if (groups.length === 0) {
      lines.push('Belum ada group tujuan.');
      lines.push('');
      lines.push('Tekan "✍️ Tambah Manual" lalu tempelkan link undangan group,');
      lines.push('atau "🔍 Cari Otomatis" untuk memuat daftar dari akun WhatsApp.');
    } else {
      lines.push(`Pesan dikirim ke SEMUA group bertanda 🟢 (${aktif.length} aktif).`);
      lines.push('');
      for (const g of groups) {
        lines.push(`${g.active ? '🟢' : '⚪'} ${g.name || '(tanpa nama)'}`);
        lines.push(`   ${g.group_id}`);
      }
      if (aktif.length === 0) {
        lines.push('');
        lines.push('⚠️ Tidak ada group aktif - peringatan tidak akan diteruskan.');
      }
    }

    const keyboard = groups.map((g) => ([
      { text: `${g.active ? '🟢' : '⚪'} ${g.name || g.group_id}`.slice(0, 30), callback_data: `g:t:${g.id}` },
      { text: '🗑️', callback_data: `g:d:${g.id}` },
    ]));
    keyboard.push([
      { text: '✍️ Tambah Manual', callback_data: 'g:man' },
      { text: '🔍 Cari Otomatis', callback_data: 'g:scan' },
    ]);
    keyboard.push([{ text: '⬅️ Kembali', callback_data: 'm:main' }]);
    return { text: lines.join('\n'), keyboard };
  }

  /** Coba ambil daftar group dari WhatsApp untuk ditambahkan. */
  async scanGroupsView() {
    const lines = ['🔍 CARI GROUP OTOMATIS', ''];
    const keyboard = [];

    if (!this.wa.isReady()) {
      lines.push('⚠️ WhatsApp belum siap. Tunggu status "ready" lalu coba lagi.');
    } else {
      let groups = [];
      try {
        groups = await this.wa.listGroups();
      } catch (err) {
        lines.push('⚠️ Daftar group tidak bisa diambil otomatis.');
        lines.push('');
        lines.push(`Sebab: ${err.message}`);
        lines.push('');
        lines.push('Ini bug yang diketahui pada whatsapp-web.js dengan build WhatsApp');
        lines.push('Web terbaru. Pengiriman pesan tetap berfungsi normal.');
        lines.push('Pakai "✍️ Tambah Manual" dengan link undangan group.');
      }
      this.groupCache = groups;
      if (groups.length > 0) {
        lines.push('Ketuk group yang ingin ditambahkan sebagai tujuan:');
        lines.push('');
        groups.forEach((g, i) => {
          const sudah = this.db.getWaGroupByGid(g.id);
          lines.push(`${i + 1}. ${g.name}${sudah ? ' (sudah ada)' : ''}`);
          keyboard.push([{ text: `${sudah ? '✅ ' : '➕ '}${g.name}`.slice(0, 40), callback_data: `g:a:${i}` }]);
        });
      }
    }

    keyboard.push([
      { text: '✍️ Tambah Manual', callback_data: 'g:man' },
      { text: '🩺 Diagnosa', callback_data: 'g:diag' },
    ]);
    keyboard.push([{ text: '⬅️ Kembali', callback_data: 'm:grp' }]);
    return { text: lines.join('\n'), keyboard };
  }

  /** Laporan isi halaman WhatsApp Web - untuk mendiagnosa daftar group. */
  async waDiagView() {
    const lines = ['🩺 DIAGNOSA WHATSAPP WEB', ''];
    if (!this.wa.isReady()) {
      lines.push('WhatsApp belum siap.');
      return { text: lines.join('\n'), keyboard: [[{ text: '⬅️ Kembali', callback_data: 'm:grp' }]] };
    }

    try {
      const info = await this.wa.probeStore();
      lines.push(`Versi WhatsApp Web : ${info.versiWA || '(tidak terbaca)'}`);
      lines.push(`window.Store       : ${info.adaStore ? 'ADA' : 'TIDAK ADA'}`);
      if (info.chat) {
        lines.push(`Store.Chat         : ${info.chat.ada ? 'ADA' : 'TIDAK ADA'}`);
        if (info.chat.ada) {
          lines.push(`  getModelsArray   : ${info.chat.punyaGetModelsArray ? 'ada' : 'tidak ada'}`);
          lines.push(`  jumlah models    : ${info.chat.jumlahModels}`);
          lines.push(`  jumlah getModels : ${info.chat.jumlahGetModels}`);
        }
      }
      if (info.groupMetadata) {
        lines.push(`Store.GroupMetadata: ${info.groupMetadata.ada ? `ADA (${info.groupMetadata.jumlah})` : 'TIDAK ADA'}`);
      }
      lines.push(`window.WWebJS      : ${info.wwebjs ? info.wwebjs.length + ' fungsi' : 'TIDAK ADA'}`);
      lines.push('');
      lines.push('Kunci window.Store yang terbaca:');
      lines.push((info.kunciStore || []).join(', ') || '(kosong)');
    } catch (err) {
      lines.push(`Gagal membaca halaman: ${err.message}`);
      if (/detached|destroyed|target closed|session closed|navigation/i.test(err.message)) {
        lines.push('');
        lines.push('➜ Halaman WhatsApp Web sudah TERLEPAS dari browser.');
        lines.push('  WhatsApp Web memuat ulang dirinya (biasanya setelah pembaruan');
        lines.push('  atau menganggur lama) dan koneksi lama menjadi tidak berguna —');
        lines.push('  termasuk untuk MENGIRIM pesan, walau status masih tampak hijau.');
        lines.push('');
        lines.push('  Koneksi sedang dibangun ulang otomatis. Sesi tetap dipakai,');
        lines.push('  jadi TIDAK perlu scan QR. Tunggu ~30 detik lalu coba lagi.');
      }
    }

    try {
      const detail = await this.wa.listGroupsFromStoreDetailed();
      lines.push('');
      lines.push('Percobaan pembacaan daftar group:');
      for (const t of (detail.tried || [])) {
        lines.push(t.error
          ? `  ${t.label} -> error: ${t.error}`
          : `  ${t.label} -> ${t.group} group dari ${t.total} objek`);
      }
      lines.push('');
      lines.push(detail.dipakai
        ? `Berhasil lewat: ${detail.dipakai} (${detail.groups.length} group)`
        : 'Tidak ada jalur yang membuahkan hasil.');
    } catch (err) {
      lines.push(`Gagal mencoba pembacaan: ${err.message}`);
    }

    lines.push('');
    lines.push('Salin seluruh pesan ini bila ingin dianalisis lebih lanjut.');
    const text = lines.join('\n');
    return {
      text: text.length > 3800 ? text.slice(0, 3800) + '\n... (dipotong)' : text,
      keyboard: [[{ text: '⬅️ Kembali', callback_data: 'm:grp' }]],
    };
  }

  /* ============================== STATUS ============================== */
  statusView() {
    const wa = this.wa.status();
    const groups = this.db.listActiveWaGroups();
    const activeUsers = this.db.listActiveUsers();
    const template = this.db.getActiveTemplate();
    const st = this.pipeline ? this.pipeline.stats : { seen: 0, matched: 0, forwarded: 0, ignored: 0, failed: 0 };

    const waIcon = wa.ready ? '🟢 Connected' : (wa.state === 'qr' ? '🟡 Menunggu scan QR' : `🔴 ${wa.state}`);
    const text = [
      '📊 STATUS BOT',
      '',
      'Telegram:',
      '🟢 Connected (bot)',
      this._userSourceLine(),
      '',
      'WhatsApp:',
      waIcon,
      wa.account ? `Akun: ${maskNumber(wa.account)}` : '',
      wa.recoveries ? `Pemulihan halaman: ${wa.recoveries}x` : '',
      '',
      `Target Group (${groups.length} aktif):`,
      groups.length ? groups.map((g) => `• ${g.name || g.group_id}`).join('\n') : '• (belum ada)',
      '',
      `Active Users: ${activeUsers.length}`,
      `Active Template: ${template ? template.name : '(tidak ada)'}`,
      `Jeda Antar Pesan: ${this.queue.delayMs} ms`,
      `Antrean Menunggu: ${this.queue.size()}`,
      `Forwarding: ${this.db.getSetting('forwarding_enabled', '1') === '1' ? 'AKTIF' : 'NONAKTIF'}`,
      '',
      `Uptime: ${fmtUptime(Date.now() - this.startedAt)}`,
      '',
      'Statistik sejak start:',
      `• Pesan masuk: ${st.seen}`,
      `• Cocok keyword: ${st.matched}`,
      `• Diteruskan: ${st.forwarded}`,
      `• Pesan mention terkirim: ${st.followUps || 0}`,
      `• Peringatan digabung: ${st.grouped || 0}`,
      `• Diabaikan: ${st.ignored}`,
      `• Gagal: ${st.failed}`,
      `• Total tercatat (anti-duplikat): ${this.db.countProcessed()}`,
    ].filter((l) => l !== '').join('\n');

    const keyboard = [[
      { text: '🔄 Refresh', callback_data: 'm:status' },
      { text: '⬅️ Kembali', callback_data: 'm:main' },
    ]];
    return { text, keyboard };
  }

  _userSourceLine() {
    if (!this.config.usesUserSource) return '';
    if (!this.userSource) return '🔴 Pembaca akun: belum dijalankan';
    const st = this.userSource.status();
    if (st.connected) {
      const extra = [];
      if (st.transport) extra.push(st.transport);
      if (st.pingMs !== null && st.pingMs !== undefined) extra.push(`ping ${st.pingMs} ms`);
      if (st.reconnects) extra.push(`${st.reconnects}x sambung ulang`);
      if (st.slowPings) extra.push(`${st.slowPings}x lambat`);
      if (st.caughtUp) extra.push(`${st.caughtUp} pesan susulan`);
      return `🟢 Pembaca akun: ${st.account || 'tersambung'} (baca saja)` +
        (extra.length ? ` — ${extra.join(', ')}` : '');
    }
    if (st.state === 'no_session') return '🔴 Pembaca akun: belum login (npm run tg:login)';
    return `🔴 Pembaca akun: ${st.state}${st.lastError ? ' - ' + st.lastError : ''}`;
  }

  /* =============================== TEST =============================== */
  testView() {
    const text = [
      '🧪 TEST',
      '',
      'Test Mention  : mengirim template aktif ke WhatsApp Group dengan REAL mention.',
      'Simulasi Pesan: menjalankan seluruh alur seperti menerima pesan Telegram asli',
      '                (forward + follow-up).',
      '',
      'Keduanya mengirim pesan sungguhan ke WhatsApp Group yang dipilih.',
    ].join('\n');
    const keyboard = [
      [{ text: '🔔 Test Mention', callback_data: 'x:mention' }],
      [{ text: '📨 Simulasi Pesan Telegram', callback_data: 'x:sim' }],
      [{ text: '⬅️ Kembali', callback_data: 'm:main' }],
    ];
    return { text, keyboard };
  }

  /* ============================ PENGATURAN ============================ */
  settingsView() {
    const text = [
      '⚙️ PENGATURAN',
      '',
      `Jeda antar pesan : ${this.queue.delayMs} ms`,
      `Jendela follow-up: ${Math.round((this.pipeline ? this.pipeline.followUpWindowMs : 0) / 1000)} detik`,
      `Format mention   : ${this.db.getSetting('mention_display', 'number') === 'name' ? 'Nama + nomor' : 'Nomor saja'}`,
      '',
      'Jendela follow-up: peringatan yang terpecah menjadi beberapa bagian',
      '("bagian 1/2", "bagian 2/2") tetap diteruskan semua, tetapi pesan',
      'mention hanya dikirim SEKALI setelah rentetan berhenti selama',
      'rentang waktu ini.',
      `Forwarding      : ${this.db.getSetting('forwarding_enabled', '1') === '1' ? 'AKTIF' : 'NONAKTIF'}`,
    ].join('\n');
    const keyboard = [
      [{ text: '🔑 Telegram Settings', callback_data: 's:tg' }, { text: '📱 WhatsApp Settings', callback_data: 's:wa' }],
      [{ text: '⏱️ Message Delay', callback_data: 's:delay' }, { text: '🔤 Format Mention', callback_data: 's:mention' }],
      [{ text: '⏳ Jendela Follow-up', callback_data: 's:fwin' }],
      [{ text: '🔁 Forwarding ON/OFF', callback_data: 's:fwd' }],
      [{ text: '🔄 Reload Configuration', callback_data: 's:reload' }],
      [{ text: '⬅️ Kembali', callback_data: 'm:main' }],
    ];
    return { text, keyboard };
  }

  telegramSettingsView() {
    const c = this.config.telegram;
    const text = [
      '🔑 TELEGRAM SETTINGS',
      '',
      'Bot Token   : •••••••••• (disembunyikan, ada di file .env)',
      `Admin IDs   : ${c.adminIds.join(', ') || '(kosong)'}`,
      `Allowed Chat: ${c.allowedChatIds.join(', ') || 'SEMUA CHAT (⚠️ isi TELEGRAM_ALLOWED_CHAT_IDS untuk produksi)'}`,
      `Sumber pesan: ${this.config.source}${this.config.usesUserSource ? ' (akun, baca saja)' : ''}`,
      this._userSourceLine(),
      '',
      'Keyword filter (tetap, tidak dapat diubah dari sini):',
      `"${KEYWORD}"`,
      '',
      'Nilai di atas diubah lewat file .env lalu restart aplikasi.',
    ].join('\n');
    return { text, keyboard: [[{ text: '⬅️ Kembali', callback_data: 'm:set' }]] };
  }

  whatsappSettingsView() {
    const wa = this.wa.status();
    const text = [
      '📱 WHATSAPP SETTINGS',
      '',
      `Status  : ${wa.state}${wa.ready ? ' 🟢' : ''}`,
      `Akun    : ${wa.account ? maskNumber(wa.account) : '(belum tersambung)'}`,
      `Client ID: ${this.config.whatsapp.clientId}`,
      `Target Group: ${this.db.listActiveWaGroups().length} aktif`,
      '',
      'Sesi WhatsApp tersimpan di folder .wwebjs_auth dan tidak pernah ditampilkan di sini.',
      'Untuk login ulang: hentikan aplikasi, hapus folder .wwebjs_auth, jalankan lagi, scan QR.',
    ].join('\n');
    return { text, keyboard: [[{ text: '⬅️ Kembali', callback_data: 'm:set' }]] };
  }

  /* ========================== CALLBACK ROUTER ========================= */
  async handleCallback(query) {
    const from = query.from || {};
    if (!this.isAdmin(from.id)) return this.denyCallback(query);

    const chatId = query.message.chat.id;
    const data = String(query.data || '');
    const [ns, action, arg] = data.split(':');

    try {
      /* ---- menu utama ---- */
      if (ns === 'm') {
        if (action === 'main') { await this._answer(query.id); return this._edit(query, this.mainMenuText(), this.mainMenuKeyboard()); }
        if (action === 'users') { await this._answer(query.id); const v = this.usersView(); return this._edit(query, v.text, v.keyboard); }
        if (action === 'tpl') { await this._answer(query.id); const v = this.templatesView(); return this._edit(query, v.text, v.keyboard); }
        if (action === 'grp') {
          await this._answer(query.id);
          const v = this.groupsView();
          return this._edit(query, v.text, v.keyboard);
        }
        if (action === 'status') { await this._answer(query.id); const v = this.statusView(); return this._edit(query, v.text, v.keyboard); }
        if (action === 'test') { await this._answer(query.id); const v = this.testView(); return this._edit(query, v.text, v.keyboard); }
        if (action === 'set') { await this._answer(query.id); const v = this.settingsView(); return this._edit(query, v.text, v.keyboard); }
      }

      /* ---- user ---- */
      if (ns === 'u') {
        if (action === 'add') {
          await this._answer(query.id);
          this.setState(chatId, from.id, 'add_user_name');
          return this._send(chatId, '➕ TAMBAH USER\n\nMasukkan nama user.\n\nKetik /batal untuk membatalkan.');
        }
        const user = this.db.getUser(arg);
        if (!user) { await this._answer(query.id, 'User tidak ditemukan', true); const v = this.usersView(); return this._edit(query, v.text, v.keyboard); }

        if (action === 'e') { await this._answer(query.id); const v = this.userDetailView(user); return this._edit(query, v.text, v.keyboard); }
        if (action === 'n') {
          await this._answer(query.id);
          this.setState(chatId, from.id, 'edit_user_name', { id: user.id });
          return this._send(chatId, `✏️ Nama saat ini: ${user.name}\n\nKirim nama baru.\n\nKetik /batal untuk membatalkan.`);
        }
        if (action === 'p') {
          await this._answer(query.id);
          this.setState(chatId, from.id, 'edit_user_number', { id: user.id });
          return this._send(chatId, `📱 Nomor saat ini: ${user.whatsapp_number}\n\nKirim nomor WhatsApp baru tanpa tanda +.\nContoh: 6281234567890\n\nKetik /batal untuk membatalkan.`);
        }
        if (action === 't') {
          const updated = this.db.updateUser(user.id, { active: user.active ? 0 : 1 });
          await this._answer(query.id, updated.active ? 'Sekarang ACTIVE' : 'Sekarang INACTIVE');
          logger.info(`User ${updated.name} diubah menjadi ${updated.active ? 'ACTIVE' : 'INACTIVE'} oleh admin ${from.id}`);
          const v = this.userDetailView(updated);
          return this._edit(query, v.text, v.keyboard);
        }
        if (action === 'd') {
          await this._answer(query.id);
          return this._edit(query,
            `⚠️ Hapus user?\n\n${user.name}\n${user.whatsapp_number}`,
            [[{ text: '✅ Ya, Hapus', callback_data: `u:D:${user.id}` }, { text: '❌ Batal', callback_data: 'm:users' }]]);
        }
        if (action === 'D') {
          this.db.deleteUser(user.id);
          logger.info(`User ${user.name} dihapus oleh admin ${from.id}`);
          await this._answer(query.id, 'User dihapus');
          const v = this.usersView();
          return this._edit(query, v.text, v.keyboard);
        }
      }

      /* ---- template ---- */
      if (ns === 't') {
        const tpl = this.db.getTemplate(arg);
        if (!tpl) { await this._answer(query.id, 'Template tidak ditemukan', true); return null; }

        if (action === 'e') {
          await this._answer(query.id);
          this.setState(chatId, from.id, 'edit_template', { id: tpl.id });
          return this._send(chatId, [
            '✏️ EDIT TEMPLATE',
            '',
            'Template saat ini:',
            '──────────',
            tpl.content,
            '──────────',
            '',
            'Silakan kirim template baru (boleh beberapa baris).',
            'Gunakan {users} sebagai penanda mention.',
            '',
            'Ketik /batal untuk membatalkan.',
          ].join('\n'));
        }
        if (action === 'p') {
          await this._answer(query.id);
          const users = this.db.listActiveUsers();
          const preview = renderPreviewForTelegram(tpl.content, users);
          const rendered = renderTemplate(tpl.content, users, { mentionDisplay: this.db.getSetting('mention_display', 'number') });
          const who = users.length ? users.map((u) => `• ${u.name} (${u.whatsapp_number})`).join('\n') : '• (tidak ada user aktif)';
          return this._send(chatId, [
            '👀 PREVIEW',
            '',
            preview,
            '',
            '──────────',
            'Yang akan di-mention (REAL WhatsApp mention):',
            who,
            '',
            'Teks persis yang dikirim ke WhatsApp:',
            '──────────',
            rendered.text,
          ].join('\n'), [[{ text: '⬅️ Kembali', callback_data: 'm:tpl' }]]);
        }
        if (action === 'x') {
          await this._answer(query.id, 'Mengirim test ke WhatsApp...');
          return this._runTestMention(chatId, tpl);
        }
        if (action === 'r') {
          this.db.resetTemplateToDefault(tpl.id);
          logger.info(`Template ${tpl.id} direset ke default oleh admin ${from.id}`);
          await this._answer(query.id, 'Template dikembalikan ke default');
          const v = this.templatesView();
          return this._edit(query, v.text, v.keyboard);
        }
      }

      /* ---- group ---- */
      if (ns === 'g' && action === 'diag') {
        await this._answer(query.id, 'Memeriksa halaman WhatsApp Web...');
        const v = await this.waDiagView();
        return this._send(chatId, v.text, v.keyboard);
      }

      if (ns === 'g' && action === 'scan') {
        await this._answer(query.id, 'Memuat daftar group...');
        const v = await this.scanGroupsView();
        return this._edit(query, v.text, v.keyboard);
      }

      if (ns === 'g' && action === 'man') {
        await this._answer(query.id);
        this.setState(chatId, from.id, 'set_group');
        return this._send(chatId, [
          '✍️ TAMBAH GROUP TUJUAN',
          '',
          'Kirim salah satu dari dua ini:',
          '',
          '1) Link undangan group (paling mudah)',
          '   Di WhatsApp: buka group > ketuk nama group >',
          '   "Undang lewat tautan" > Salin tautan.',
          '   Contoh: https://chat.whatsapp.com/AbCdEf123456',
          '',
          '2) Group ID langsung',
          '   Contoh: 120363011111111111@g.us',
          '',
          'Group yang ditambahkan langsung berstatus aktif.',
          'Ketik /batal untuk membatalkan.',
        ].join('\n'));
      }

      if (ns === 'g' && action === 'a') {
        const found = this.groupCache[Number(arg)];
        if (!found) {
          await this._answer(query.id, 'Daftar kedaluwarsa, muat ulang.', true);
          const v = await this.scanGroupsView();
          return this._edit(query, v.text, v.keyboard);
        }
        this.db.addWaGroup(found.id, found.name);
        logger.info(`Group tujuan ditambahkan: "${found.name}" (${found.id}) oleh admin ${from.id}`);
        await this._answer(query.id, `Ditambahkan: ${found.name}`);
        const v = this.groupsView();
        return this._edit(query, v.text, v.keyboard);
      }

      if (ns === 'g' && (action === 't' || action === 'd' || action === 'D')) {
        const group = this.db.getWaGroup(arg);
        if (!group) {
          await this._answer(query.id, 'Group tidak ditemukan', true);
          const v = this.groupsView();
          return this._edit(query, v.text, v.keyboard);
        }

        if (action === 't') {
          const updated = this.db.updateWaGroup(group.id, { active: group.active ? 0 : 1 });
          logger.info(`Group "${updated.name}" ${updated.active ? 'DIAKTIFKAN' : 'DINONAKTIFKAN'} oleh admin ${from.id}`);
          await this._answer(query.id, updated.active ? 'Aktif' : 'Nonaktif');
          const v = this.groupsView();
          return this._edit(query, v.text, v.keyboard);
        }
        if (action === 'd') {
          await this._answer(query.id);
          return this._edit(query,
            `⚠️ Hapus group tujuan?\n\n${group.name || '(tanpa nama)'}\n${group.group_id}`,
            [[{ text: '✅ Ya, Hapus', callback_data: `g:D:${group.id}` }, { text: '❌ Batal', callback_data: 'm:grp' }]]);
        }
        this.db.deleteWaGroup(group.id);
        logger.info(`Group tujuan dihapus: "${group.name}" oleh admin ${from.id}`);
        await this._answer(query.id, 'Group dihapus');
        const v = this.groupsView();
        return this._edit(query, v.text, v.keyboard);
      }

      /* ---- test ---- */
      if (ns === 'x') {
        if (action === 'mention') {
          await this._answer(query.id, 'Mengirim...');
          return this._runTestMention(chatId, this.db.getActiveTemplate());
        }
        if (action === 'sim') {
          await this._answer(query.id, 'Menjalankan simulasi...');
          const sample = `[SIMULASI] PERINGATAN STOK SHOPEE\nDitemukan 110 SKU dengan stok tersedia di bawah stok ter-reserve (Area: Pusat).\n${new Date().toISOString()}`;
          const res = await this.pipeline.handle({
            chatId: this.config.telegram.allowedChatIds[0] || chatId,
            messageId: `sim-${Date.now()}`,
            text: sample,
          });
          return this._send(chatId, `📨 Simulasi selesai.\nHasil: ${res.action}${res.reason ? ` (${res.reason})` : ''}`,
            [[{ text: '⬅️ Kembali', callback_data: 'm:test' }]]);
        }
      }

      /* ---- pengaturan ---- */
      if (ns === 's') {
        if (action === 'tg') { await this._answer(query.id); const v = this.telegramSettingsView(); return this._edit(query, v.text, v.keyboard); }
        if (action === 'wa') { await this._answer(query.id); const v = this.whatsappSettingsView(); return this._edit(query, v.text, v.keyboard); }
        if (action === 'delay') {
          await this._answer(query.id);
          this.setState(chatId, from.id, 'set_delay');
          return this._send(chatId, `⏱️ Jeda saat ini: ${this.queue.delayMs} ms\n\nKirim angka baru dalam milidetik (minimal 3000).\n\nKetik /batal untuk membatalkan.`);
        }
        if (action === 'fwin') {
          await this._answer(query.id);
          this.setState(chatId, from.id, 'set_followup_window');
          return this._send(chatId, [
            '⏳ JENDELA FOLLOW-UP',
            '',
            `Saat ini: ${Math.round(this.pipeline.followUpWindowMs / 1000)} detik.`,
            '',
            'Setelah peringatan pertama diteruskan, bot menunggu selama rentang',
            'ini. Setiap peringatan baru yang masuk memperpanjang penantian.',
            'Begitu tenang, satu pesan mention dikirim untuk seluruh rentetan.',
            '',
            'Kirim angka dalam DETIK (0 - 120).',
            '0 = kirim mention untuk setiap peringatan (perilaku lama).',
            '',
            'Ketik /batal untuk membatalkan.',
          ].join('\n'));
        }
        if (action === 'mention') {
          const cur = this.db.getSetting('mention_display', 'number');
          const next = cur === 'name' ? 'number' : 'name';
          this.db.setSetting('mention_display', next);
          await this._answer(query.id, next === 'name' ? 'Nama + nomor' : 'Nomor saja');
          const v = this.settingsView();
          return this._edit(query, v.text, v.keyboard);
        }
        if (action === 'fwd') {
          const cur = this.db.getSetting('forwarding_enabled', '1');
          const next = cur === '1' ? '0' : '1';
          this.db.setSetting('forwarding_enabled', next);
          logger.warn(`Forwarding di-set ${next === '1' ? 'AKTIF' : 'NONAKTIF'} oleh admin ${from.id}`);
          await this._answer(query.id, next === '1' ? 'Forwarding AKTIF' : 'Forwarding NONAKTIF');
          const v = this.settingsView();
          return this._edit(query, v.text, v.keyboard);
        }
        if (action === 'reload') {
          const delay = Number(this.db.getSetting('message_delay_ms', this.config.messageDelayMs));
          this.queue.setDelay(Math.max(3000, delay));
          const win = this.db.getSetting('followup_window_ms', null);
          if (win !== null) this.pipeline.followUpWindowMs = Math.max(0, Number(win));
          const gid = this.db.getSetting('wa_group_id', '');
          if (gid && this.wa.isReady()) {
            const name = await this.wa.getChatName(gid);
            if (name) this.db.setSetting('wa_group_name', name);
          }
          await this._answer(query.id, 'Konfigurasi dimuat ulang');
          const v = this.settingsView();
          return this._edit(query, v.text, v.keyboard);
        }
      }

      await this._answer(query.id);
      return null;
    } catch (err) {
      logger.error('Error pada Admin Menu:', err.message);
      await this._answer(query.id, 'Terjadi kesalahan, cek log.', true);
      return null;
    }
  }

  async _runTestMention(chatId, template) {
    if (!template) return this._send(chatId, '⚠️ Tidak ada template.');

    const groups = this.db.listActiveWaGroups();
    if (groups.length === 0) {
      return this._send(chatId, '⚠️ Belum ada WhatsApp Group aktif.\nBuka Admin Menu > WhatsApp Group.',
        [[{ text: '📱 Atur Group', callback_data: 'm:grp' }]]);
    }
    if (!this.wa.isReady()) {
      return this._send(chatId, '⚠️ WhatsApp belum siap. Cek Status Bot.', [[{ text: '📊 Status', callback_data: 'm:status' }]]);
    }

    const users = this.db.listActiveUsers();
    const rendered = renderTemplate(template.content, users, {
      mentionDisplay: this.db.getSetting('mention_display', 'number'),
    });

    const hasil = [];
    for (const g of groups) {
      try {
        await this.queue.enqueue(
          () => this.wa.sendText(g.group_id, rendered.text, rendered.mentions),
          `test-mention -> ${g.name}`
        );
        hasil.push(`✅ ${g.name || g.group_id}`);
      } catch (err) {
        hasil.push(`❌ ${g.name || g.group_id} — ${err.message}`);
      }
    }

    return this._send(chatId, [
      'Hasil pengiriman test:',
      hasil.join('\n'),
      '',
      `Mention: ${rendered.mentions.length} user`,
      users.map((u) => `• ${u.name} (${u.whatsapp_number})`).join('\n') || '• (tidak ada user aktif)',
    ].join('\n'), [[{ text: '⬅️ Kembali', callback_data: 'm:main' }]]);
  }

  /* ======================= INPUT TEKS BERTAHAP ======================== */
  /**
   * @returns {Promise<boolean>} true bila teks dikonsumsi oleh Admin Menu
   */
  async handleText(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from && msg.from.id;
    const state = this.getState(chatId, userId);
    if (!state) return false;
    if (!this.isAdmin(userId)) { this.clearState(chatId, userId); return false; }

    const text = (msg.text || '').trim();
    if (text === '/batal' || text === '/cancel') {
      this.clearState(chatId, userId);
      await this._send(chatId, '❌ Dibatalkan.', this.mainMenuKeyboard());
      return true;
    }

    try {
      switch (state.action) {
        case 'add_user_name': {
          if (text.length < 2 || text.length > 60) {
            await this._send(chatId, '⚠️ Nama harus 2-60 karakter. Coba lagi atau /batal.');
            return true;
          }
          this.setState(chatId, userId, 'add_user_number', { name: text });
          await this._send(chatId, `Nama: ${text}\n\nMasukkan nomor WhatsApp tanpa +.\nContoh: 6281234567890`);
          return true;
        }
        case 'add_user_number': {
          const v = validateWhatsappNumber(text);
          if (!v.ok) { await this._send(chatId, `⚠️ ${v.error}\n\nCoba lagi atau /batal.`); return true; }
          if (this.db.getUserByNumber(v.value)) {
            await this._send(chatId, `⚠️ Nomor ${v.value} sudah terdaftar.\n\nCoba nomor lain atau /batal.`);
            return true;
          }
          const user = this.db.createUser(state.data.name, v.value);
          this.clearState(chatId, userId);
          logger.info(`User baru ditambahkan: ${user.name} (${user.whatsapp_number}) oleh admin ${userId}`);
          await this._send(chatId, `✅ User berhasil ditambahkan.\n\n${user.name}\n${user.whatsapp_number}\nStatus: ACTIVE`);
          const view = this.usersView();
          await this._send(chatId, view.text, view.keyboard);
          return true;
        }
        case 'edit_user_name': {
          if (text.length < 2 || text.length > 60) { await this._send(chatId, '⚠️ Nama harus 2-60 karakter. Coba lagi atau /batal.'); return true; }
          const user = this.db.updateUser(state.data.id, { name: text });
          this.clearState(chatId, userId);
          logger.info(`Nama user ${state.data.id} diubah menjadi "${text}" oleh admin ${userId}`);
          await this._send(chatId, '✅ Nama diperbarui.');
          const v = this.userDetailView(user);
          await this._send(chatId, v.text, v.keyboard);
          return true;
        }
        case 'edit_user_number': {
          const v = validateWhatsappNumber(text);
          if (!v.ok) { await this._send(chatId, `⚠️ ${v.error}\n\nCoba lagi atau /batal.`); return true; }
          const dup = this.db.getUserByNumber(v.value);
          if (dup && dup.id !== state.data.id) {
            await this._send(chatId, `⚠️ Nomor ${v.value} sudah dipakai user "${dup.name}".`);
            return true;
          }
          const user = this.db.updateUser(state.data.id, { whatsapp_number: v.value });
          this.clearState(chatId, userId);
          logger.info(`Nomor user ${state.data.id} diubah oleh admin ${userId}`);
          await this._send(chatId, '✅ Nomor diperbarui.');
          const view = this.userDetailView(user);
          await this._send(chatId, view.text, view.keyboard);
          return true;
        }
        case 'edit_template': {
          const raw = msg.text || '';
          if (raw.trim().length < 5) { await this._send(chatId, '⚠️ Template terlalu pendek. Coba lagi atau /batal.'); return true; }
          this.setState(chatId, userId, 'confirm_template', { id: state.data.id, content: raw });
          const users = this.db.listActiveUsers();
          await this._send(chatId, [
            '📄 Template baru:',
            '──────────',
            raw,
            '──────────',
            '',
            raw.includes('{users}') ? '✅ Placeholder {users} ditemukan.' : '⚠️ Tidak ada {users} - tidak akan ada mention!',
            '',
            'Preview:',
            renderPreviewForTelegram(raw, users),
          ].join('\n'), [[
            { text: '💾 Simpan Template', callback_data: 'tc:save' },
            { text: '❌ Batal', callback_data: 'tc:cancel' },
          ]]);
          return true;
        }
        case 'set_group': {
          const input = text.trim();
          const isJid = /^\d{5,}(-\d+)?@g\.us$/.test(input);
          const isInvite = /chat\.whatsapp\.com\//i.test(input) || /^[A-Za-z0-9_-]{15,30}$/.test(input);

          if (!isJid && !isInvite) {
            await this._send(chatId, '⚠️ Tidak dikenali. Kirim link undangan group atau Group ID yang berakhiran @g.us.\n\nCoba lagi atau /batal.');
            return true;
          }

          let group;
          if (isJid) {
            group = { id: input, name: '' };
            if (this.wa.isReady()) {
              const name = await this.wa.getChatName(input);
              if (name) group.name = name;
            }
          } else {
            try {
              group = await this.wa.resolveInvite(input);
            } catch (err) {
              await this._send(chatId, `⚠️ Gagal membaca link undangan: ${err.message}\n\nCoba kirim Group ID (…@g.us) atau /batal.`);
              return true;
            }
          }

          const saved = this.db.addWaGroup(group.id, group.name || '');
          const total = this.db.listActiveWaGroups().length;
          this.clearState(chatId, userId);
          logger.info(`Group tujuan ditambahkan manual: "${saved.name || '-'}" (${saved.group_id}) oleh admin ${userId}`);
          await this._send(chatId, [
            '✅ Group tujuan tersimpan dan langsung aktif.',
            '',
            `Nama: ${saved.name || '(belum diketahui)'}`,
            `ID  : ${saved.group_id}`,
            '',
            `Total group aktif sekarang: ${total}.`,
            'Uji sekarang lewat 🧪 Test > 🔔 Test Mention.',
          ].join('\n'), [
            [{ text: '🔔 Test Mention', callback_data: 'x:mention' }],
            [{ text: '📱 Daftar Group', callback_data: 'm:grp' }],
            [{ text: '⬅️ Menu Utama', callback_data: 'm:main' }],
          ]);
          return true;
        }
        case 'set_followup_window': {
          const detik = parseInt(text, 10);
          if (!Number.isFinite(detik) || detik < 0 || detik > 120) {
            await this._send(chatId, '⚠️ Masukkan angka 0 - 120 (detik). Coba lagi atau /batal.');
            return true;
          }
          this.pipeline.followUpWindowMs = detik * 1000;
          this.db.setSetting('followup_window_ms', detik * 1000);
          this.clearState(chatId, userId);
          logger.info(`Jendela follow-up diubah menjadi ${detik} detik oleh admin ${userId}`);
          await this._send(chatId, detik === 0
            ? '✅ Jendela follow-up dimatikan. Setiap peringatan akan menghasilkan pesan mention sendiri.'
            : `✅ Jendela follow-up diubah menjadi ${detik} detik.`);
          const v = this.settingsView();
          await this._send(chatId, v.text, v.keyboard);
          return true;
        }
        case 'set_delay': {
          const n = parseInt(text, 10);
          if (!Number.isFinite(n) || n < 3000 || n > 600000) {
            await this._send(chatId, '⚠️ Masukkan angka 3000 - 600000 (milidetik). Coba lagi atau /batal.');
            return true;
          }
          this.db.setSetting('message_delay_ms', n);
          this.queue.setDelay(n);
          this.clearState(chatId, userId);
          await this._send(chatId, `✅ Jeda antar pesan diubah menjadi ${n} ms.`);
          const v = this.settingsView();
          await this._send(chatId, v.text, v.keyboard);
          return true;
        }
        default:
          return false;
      }
    } catch (err) {
      logger.error('Gagal memproses input admin:', err.message);
      this.clearState(chatId, userId);
      await this._send(chatId, `❌ Terjadi kesalahan: ${err.message}`);
      return true;
    }
  }

  /** Konfirmasi simpan template (callback terpisah karena butuh state). */
  async handleTemplateConfirm(query) {
    const from = query.from || {};
    if (!this.isAdmin(from.id)) return this.denyCallback(query);
    const chatId = query.message.chat.id;
    const state = this.getState(chatId, from.id);
    const [, action] = String(query.data).split(':');

    if (!state || state.action !== 'confirm_template') {
      await this._answer(query.id, 'Sesi edit sudah berakhir.', true);
      return null;
    }
    if (action === 'cancel') {
      this.clearState(chatId, from.id);
      await this._answer(query.id, 'Dibatalkan');
      return this._edit(query, '❌ Perubahan template dibatalkan.', [[{ text: '⬅️ Kembali', callback_data: 'm:tpl' }]]);
    }
    this.db.updateTemplate(state.data.id, { content: state.data.content });
    this.clearState(chatId, from.id);
    logger.info(`Template ${state.data.id} diperbarui oleh admin ${from.id}`);
    await this._answer(query.id, 'Template disimpan');
    return this._edit(query, '✅ Template berhasil disimpan.', [[{ text: '📝 Lihat Template', callback_data: 'm:tpl' }]]);
  }
}

module.exports = AdminMenu;
module.exports.DENIED = DENIED;
module.exports.fmtUptime = fmtUptime;
