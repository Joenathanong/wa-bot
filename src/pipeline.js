'use strict';

const logger = require('./logger').scope('FLOW');
const { shouldForward, KEYWORD_DEFAULT } = require('./filter');
const { renderTemplate, mintaTagSemua } = require('./render');
const tujuan = require('./tujuan');

/**
 * Alur otomatis Telegram -> WhatsApp.
 * SATU ARAH SAJA. Tidak ada jalur WhatsApp -> Telegram, sehingga
 * loop pesan tidak mungkin terjadi.
 */
class Pipeline {
  constructor({ db, whatsapp, queue, config, notifyAdmins = null, followUpWindowMs = null, followUpMaxWaitMs = null }) {
    this.db = db;
    this.wa = whatsapp;
    this.queue = queue;
    this.config = config;
    this.notifyAdmins = notifyAdmins;

    // Bot pengirim sering memecah satu peringatan menjadi beberapa pesan
    // ("bagian 1/2", "bagian 2/2"). Seluruh bagian tetap diteruskan, tetapi
    // pesan follow-up dengan mention hanya dikirim SEKALI setelah rentetan
    // pesan berhenti selama followUpWindowMs.
    this.followUpWindowMs = followUpWindowMs !== null
      ? followUpWindowMs
      : (config.followUp ? config.followUp.windowMs : 15000);
    this.followUpMaxWaitMs = followUpMaxWaitMs !== null
      ? followUpMaxWaitMs
      : (config.followUp ? config.followUp.maxWaitMs : 120000);

    this.stats = { seen: 0, matched: 0, ignored: 0, duplicated: 0, forwarded: 0, failed: 0, followUps: 0, grouped: 0, skipped: 0 };
    this._inFlight = new Set();
    this._pending = null;       // {group, count, firstAt}
    this._followUpTimer = null;
    // Daftar anggota group untuk "tag all". Disimpan sebentar (ANGGOTA_TTL_MS)
    // karena membacanya berarti menanyai halaman WhatsApp Web - mahal, dan
    // keanggotaan group tidak berubah tiap menit.
    this._anggota = new Map();  // groupId -> {jids, saat}
    // Sidik jari bentrok tujuan; dipakai agar peringatan "dua jalur satu
    // group" dikirim sekali per keadaan, bukan tiap pesan masuk.
    this._sidikBentrok = null;
  }

  /**
   * Keyword pemicu yang SEDANG berlaku. Dibaca ulang tiap pesan supaya
   * perubahan lewat /keyword langsung berlaku tanpa restart.
   * String kosong berarti sengaja tanpa saringan kata.
   */
  keywordAktif() {
    const tersimpan = this.db.getSetting('forward_keyword', null);
    if (tersimpan !== null) return String(tersimpan);
    return this.config.forwardKeyword !== undefined
      ? String(this.config.forwardKeyword)
      : KEYWORD_DEFAULT;
  }

  /**
   * Cara mention dikirim:
   *   'gabung' - ditempel di bawah teks pesanan, hanya SATU pesan (default)
   *   'pisah'  - pesan kedua terpisah (perilaku lama)
   *   'mati'   - tanpa mention sama sekali
   */
  modeMention() {
    const tersimpan = this.db.getSetting('mention_mode', null);
    const v = String(tersimpan !== null
      ? tersimpan
      : (this.config.mentionMode || 'gabung')).toLowerCase();
    return ['gabung', 'pisah', 'mati'].includes(v) ? v : 'gabung';
  }

  /**
   * "Tag semua anggota group" untuk pesan forwarder.
   *
   * Menyala berarti SELURUH anggota group tujuan ikut di-mention, bukan hanya
   * user yang terdaftar di Admin Menu. Teks pesannya tidak berubah: JID
   * anggota dikirim lewat opsi `mentions`, dan WhatsApp tetap memberi
   * notifikasi ke semua orang - "tag tersembunyi". Template yang memuat
   * {all} menyalakannya sendiri, dengan nomor yang ikut terlihat.
   */
  tagSemuaAktif() {
    const tersimpan = this.db.getSetting('mention_all', null);
    if (tersimpan !== null && tersimpan !== undefined && tersimpan !== '') {
      return String(tersimpan) === '1';
    }
    return this.config && this.config.mentionAll === true;
  }

  /**
   * JID seluruh anggota sebuah group. Kegagalan TIDAK membatalkan pengiriman:
   * lebih baik pesan sampai dengan mention seadanya daripada tidak sampai.
   */
  async _anggotaGroup(groupId) {
    if (!this.wa || typeof this.wa.groupParticipants !== 'function') return [];
    const simpan = this._anggota.get(groupId);
    if (simpan && (Date.now() - simpan.saat) < Pipeline.ANGGOTA_TTL_MS) return simpan.jids;
    try {
      const jids = await this.wa.groupParticipants(groupId);
      this._anggota.set(groupId, { jids, saat: Date.now() });
      return jids;
    } catch (err) {
      logger.warn(`Daftar anggota group ${groupId} tidak terbaca (tag semua dilewati): ${err.message}`);
      return simpan ? simpan.jids : [];
    }
  }

  /** Buang ingatan daftar anggota (dipakai setelah anggota group berubah). */
  lupakanAnggota(groupId = null) {
    if (groupId) this._anggota.delete(groupId);
    else this._anggota.clear();
  }

  /**
   * Potongan mention siap tempel untuk SATU group tujuan.
   *
   * Dulu potongan ini dihitung sekali untuk semua group. Itu tidak bisa
   * dipertahankan begitu ada "tag semua anggota": anggota tiap group berbeda,
   * jadi mention-nya harus dibentuk per group.
   *
   * Mengembalikan teks kosong bila mention dimatikan atau template/user
   * belum disiapkan.
   */
  async _potonganMention(groupId = null) {
    if (this.modeMention() !== 'gabung') return { teks: '', mentions: [] };
    const template = this.db.getActiveTemplate();
    if (!template) return { teks: '', mentions: [] };
    const users = this.db.listActiveUsers();
    const tagAll = this.tagSemuaAktif();
    const perlu = tagAll || mintaTagSemua(template.content);
    const allJids = (perlu && groupId) ? await this._anggotaGroup(groupId) : [];
    const rendered = renderTemplate(template.content, users, {
      mentionDisplay: this.db.getSetting('mention_display', 'number'),
      count: 1,
      allJids,
      tagAll,
    });
    const teks = String(rendered.text || '').trim();
    if (!teks) return { teks: '', mentions: [] };
    return { teks, mentions: rendered.mentions };
  }

  /**
   * WhatsApp Group tujuan FORWARDER.
   *
   * Bukan lagi sekadar "semua group aktif": group yang sudah menjadi tujuan
   * PERINGATAN LOCK STOCK disingkirkan di sini, supaya dua jalur yang punya
   * PIC dan irama sendiri tidak menumpuk di ruang yang sama. Lihat
   * src/tujuan.js untuk aturan lengkapnya, termasuk kenapa pemisahan ini
   * TIDAK pernah membuat daftar tujuan forwarder menjadi kosong.
   */
  targetGroups() {
    const rinci = tujuan.tujuanForwarderRinci(this.db, this.config);
    if (rinci.disingkirkan.length > 0) {
      const nama = rinci.disingkirkan.map((g) => g.name).join(', ');
      this._sekaliBentrok(`pisah:${nama}`, () => logger.info(
        `Group "${nama}" dilewati forwarder - group itu tujuan Peringatan Lock Stock.`
      ));
    } else if (rinci.tidakBisaDipisah) {
      const nama = rinci.groups.map((g) => g.name).join(', ');
      this._sekaliBentrok(`sama:${nama}`, () => {
        logger.warn(
          `Group "${nama}" dipakai forwarder DAN peringatan lock stock sekaligus, `
          + 'dan tidak ada group aktif lain sebagai gantinya - forward tetap dikirim '
          + 'ke sana supaya pesanan tidak berhenti.'
        );
        this._notify(
          `Forwarder Telegram dan Peringatan Lock Stock sama-sama memakai group "${nama}".\n\n`
          + 'Tidak dipisah otomatis karena itu satu-satunya group aktif - memberhentikan '
          + 'forward pesanan jauh lebih merugikan. Pilih salah satu:\n'
          + '  a) /lockgroup <group lain> - pindahkan peringatan lock stock, atau\n'
          + '  b) tambah group baru di /groups lalu nonaktifkan yang ini.\n\n'
          + 'Periksa kapan saja dengan /tujuan.'
        );
      });
    } else {
      this._sidikBentrok = null;
    }
    return rinci.groups.map((g) => ({ id: g.id, name: g.name }));
  }

  /** Jalankan sesuatu sekali saja selama keadaannya belum berubah. */
  _sekaliBentrok(sidik, fn) {
    if (this._sidikBentrok === sidik) return;
    this._sidikBentrok = sidik;
    try { fn(); } catch (e) { /* jangan sampai menggagalkan pengiriman */ }
  }

  /**
   * Apakah pesan ini MEMENUHI KRITERIA dan belum pernah diteruskan?
   * Dipakai oleh susulan (catch-up) untuk memilih pesan terakhir saja,
   * tanpa mengirim apa pun. Kriterianya persis sama dengan handle():
   * chat diizinkan, keyword cocok, dan belum tercatat di processed_messages.
   * @returns {boolean}
   */
  layakDiteruskan(chatId, messageId, text) {
    const c = String(chatId);
    const m = String(messageId);
    if (!this.config.isAllowedChat(c)) return false;
    if (!shouldForward(text || '', this.keywordAktif())) return false;
    if (this._inFlight.has(`${c}:${m}`) || this.db.isProcessed(c, m)) return false;
    return true;
  }

  /**
   * Tandai pesan sebagai terproses TANPA mengirim apa pun ke WhatsApp.
   * Dipakai untuk peringatan lama yang sudah kedaluwarsa setelah restart:
   * hanya yang terakhir yang dikirim, sisanya dilewati supaya tidak
   * membanjiri group dengan data basi.
   */
  lewati(chatId, messageId, alasan = 'bukan pesan terakhir') {
    const c = String(chatId);
    const m = String(messageId);
    this.db.markProcessed(c, m);
    this.stats.skipped += 1;
    logger.info(`Dilewati (${alasan}): chat ${c} msg ${m} - tidak dikirim ke WhatsApp.`);
    return { action: 'skipped', reason: alasan };
  }

  /**
   * @param {{chatId: string|number, messageId: string|number, text: string, chatTitle?: string}} input
   * @returns {Promise<{action: string, reason?: string}>}
   */
  async handle(input) {
    const chatId = String(input.chatId);
    const messageId = String(input.messageId);
    const text = input.text || '';

    this.stats.seen += 1;

    // 1. Filter Chat ID
    if (!this.config.isAllowedChat(chatId)) {
      logger.debug(`Diabaikan: chat ${chatId} tidak ada di TELEGRAM_ALLOWED_CHAT_IDS`);
      this.stats.ignored += 1;
      return { action: 'ignored', reason: 'chat_not_allowed' };
    }

    // 2 & 3. Ambil teks polos lalu cek keyword
    if (!shouldForward(text, this.keywordAktif())) {
      logger.debug(`Diabaikan: keyword tidak ditemukan (chat ${chatId}, msg ${messageId})`);
      this.stats.ignored += 1;
      return { action: 'ignored', reason: 'no_keyword' };
    }

    this.stats.matched += 1;

    // 4. Proteksi duplikat
    const key = `${chatId}:${messageId}`;
    if (this._inFlight.has(key) || this.db.isProcessed(chatId, messageId)) {
      logger.warn(`Duplikat diabaikan: chat ${chatId} msg ${messageId}`);
      this.stats.duplicated += 1;
      return { action: 'duplicate' };
    }

    if (this.db.getSetting('forwarding_enabled', '1') !== '1') {
      logger.warn('Forwarding sedang DIMATIKAN lewat Pengaturan - pesan tidak diteruskan');
      return { action: 'disabled' };
    }

    const groups = this.targetGroups();
    if (groups.length === 0) {
      logger.error('Belum ada WhatsApp Group aktif. Buka Admin Menu > WhatsApp Group.');
      this._notify('Keyword terdeteksi, tetapi belum ada WhatsApp Group aktif. Buka /groups untuk menambahkannya.');
      this.stats.failed += 1;
      return { action: 'failed', reason: 'no_group' };
    }

    if (!this.wa.isReady()) {
      logger.error('WhatsApp belum siap - pesan TIDAK diteruskan dan tidak ditandai terproses.');
      this._notify('Keyword terdeteksi, tetapi WhatsApp belum tersambung. Pesan tidak diteruskan.');
      this.stats.failed += 1;
      return { action: 'failed', reason: 'wa_not_ready' };
    }

    this._inFlight.add(key);
    logger.info(`Keyword cocok - meneruskan pesan Telegram ${messageId} dari chat ${chatId}`);

    try {
      // 5. Teruskan isi asli Telegram ke SEMUA group aktif.
      // Header "[FORWARDED FROM TELEGRAM]" dibuang: isi pesan sekarang
      // adalah perintah kerja operasional, bukan kutipan chat.
      // Mention ikut DITEMPEL di sini (mode 'gabung') supaya satu pesanan
      // hanya menghasilkan satu notifikasi di group WhatsApp.
      const hasil = [];
      for (const group of groups) {
        try {
          // Mention dibentuk PER GROUP: bila "tag semua anggota" menyala,
          // anggota tiap group berbeda-beda.
          const tempel = await this._potonganMention(group.id);
          const forwardText = tempel.teks ? `${text}\n\n${tempel.teks}` : text;
          await this.queue.enqueue(
            () => this.wa.sendText(group.id, forwardText, tempel.mentions),
            `forward ${messageId} -> ${group.name}`
          );
          hasil.push({ group, ok: true });
        } catch (err) {
          hasil.push({ group, ok: false, error: err.message });
          logger.error(`Gagal meneruskan ke group "${group.name}": ${err.message}`);
        }
      }

      const berhasil = hasil.filter((h) => h.ok);
      if (berhasil.length === 0) {
        this.stats.failed += 1;
        const sebab = hasil.map((h) => `${h.group.name}: ${h.error}`).join(' | ');
        this._notify(`Gagal meneruskan pesan ke seluruh WhatsApp Group. ${sebab}`);
        return { action: 'failed', reason: sebab };
      }
      if (berhasil.length < groups.length) {
        const gagal = hasil.filter((h) => !h.ok).map((h) => h.group.name).join(', ');
        this._notify(`Pesan diteruskan ke ${berhasil.length}/${groups.length} group. Gagal: ${gagal}`);
      }

      // 6-10. Pesan kedua berisi mention HANYA pada mode 'pisah'.
      // Pada mode 'gabung' (default) mention sudah ikut di pesan di atas.
      if (this.modeMention() === 'pisah') this._scheduleFollowUp();

      // 11. Catat sebagai terproses hanya setelah berhasil
      this.db.markProcessed(chatId, messageId);
      this.stats.forwarded += 1;
      logger.info(
        `Selesai meneruskan pesan ${messageId} ke ${berhasil.length} group: ` +
        berhasil.map((h) => `"${h.group.name}"`).join(', ')
      );
      return { action: 'forwarded', groups: berhasil.length };
    } catch (err) {
      this.stats.failed += 1;
      logger.error('Gagal meneruskan pesan:', err.message);
      this._notify(`Gagal meneruskan pesan ke WhatsApp: ${err.message}`);
      return { action: 'failed', reason: err.message };
    } finally {
      this._inFlight.delete(key);
    }
  }

  /* ------------------- follow-up yang dikelompokkan ------------------ */

  _scheduleFollowUp() {
    const now = Date.now();
    if (this._pending) {
      this._pending.count += 1;
      this.stats.grouped += 1;
      logger.info(`Peringatan ke-${this._pending.count} dalam rentetan yang sama - follow-up tetap satu pesan.`);
    } else {
      this._pending = { count: 1, firstAt: now };
    }

    if (this._followUpTimer) clearTimeout(this._followUpTimer);

    if (this.followUpWindowMs <= 0) { return this._sendFollowUp(); }

    const waited = now - this._pending.firstAt;
    const remainingMax = Math.max(0, this.followUpMaxWaitMs - waited);
    const delay = Math.max(0, Math.min(this.followUpWindowMs, remainingMax));

    this._followUpTimer = setTimeout(() => {
      this._sendFollowUp().catch((err) => logger.error('Gagal mengirim follow-up:', err.message));
    }, delay);
    if (this._followUpTimer.unref) this._followUpTimer.unref();
    return null;
  }

  /** Kirim satu pesan follow-up untuk seluruh rentetan yang tertampung. */
  async _sendFollowUp() {
    if (this._followUpTimer) { clearTimeout(this._followUpTimer); this._followUpTimer = null; }
    const pending = this._pending;
    this._pending = null;
    if (!pending) return null;

    const template = this.db.getActiveTemplate();
    if (!template) {
      logger.warn('Tidak ada template aktif - pesan follow-up dilewati');
      return null;
    }
    const users = this.db.listActiveUsers();
    if (users.length === 0) {
      logger.warn('Tidak ada user ACTIVE - follow-up dikirim tanpa mention');
    }
    const tagAll = this.tagSemuaAktif();
    const perluAnggota = tagAll || mintaTagSemua(template.content);

    // Daftar group dibaca ulang di sini, bukan saat dijadwalkan, supaya
    // perubahan target lewat Admin Menu langsung ikut berlaku.
    const groups = this.targetGroups();
    if (groups.length === 0) {
      logger.warn('Tidak ada group aktif saat follow-up akan dikirim - dilewati.');
      return null;
    }

    let terkirim = 0;
    for (const group of groups) {
      try {
        const allJids = perluAnggota ? await this._anggotaGroup(group.id) : [];
        const rendered = renderTemplate(template.content, users, {
          mentionDisplay: this.db.getSetting('mention_display', 'number'),
          count: pending.count,
          allJids,
          tagAll,
        });
        await this.queue.enqueue(
          () => this.wa.sendText(group.id, rendered.text, rendered.mentions),
          `follow-up -> ${group.name} (${pending.count} peringatan, ${rendered.mentions.length} mention)`
        );
        terkirim += 1;
      } catch (err) {
        logger.error(`Gagal mengirim follow-up ke "${group.name}": ${err.message}`);
        this._notify(`Gagal mengirim pesan follow-up ke group "${group.name}": ${err.message}`);
      }
    }

    if (terkirim === 0) return { action: 'follow-up-failed' };
    this.stats.followUps += 1;
    logger.info(`Follow-up terkirim satu kali ke ${terkirim} group untuk ${pending.count} pesan peringatan.`);
    return { action: 'follow-up-sent', count: pending.count, groups: terkirim };
  }

  /** Kirim follow-up yang masih tertunda (dipakai saat aplikasi dimatikan). */
  async flushFollowUp() {
    if (!this._pending) return null;
    logger.info('Mengirim follow-up yang masih tertunda sebelum berhenti...');
    return this._sendFollowUp();
  }

  _notify(text) {
    if (typeof this.notifyAdmins === 'function') {
      try { this.notifyAdmins(text); } catch (e) { /* ignore */ }
    }
  }
}

/** Lama daftar anggota group diingat sebelum dibaca ulang (ms). */
Pipeline.ANGGOTA_TTL_MS = 5 * 60 * 1000;

module.exports = Pipeline;
module.exports.KEYWORD = KEYWORD_DEFAULT;
