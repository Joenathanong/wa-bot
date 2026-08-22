'use strict';

const logger = require('./logger').scope('FLOW');
const { shouldForward, KEYWORD } = require('./filter');
const { renderTemplate } = require('./render');

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

    this.stats = { seen: 0, matched: 0, ignored: 0, duplicated: 0, forwarded: 0, failed: 0, followUps: 0, grouped: 0 };
    this._inFlight = new Set();
    this._pending = null;       // {group, count, firstAt}
    this._followUpTimer = null;
  }

  /** Seluruh WhatsApp Group tujuan yang sedang aktif. */
  targetGroups() {
    return this.db.listActiveWaGroups().map((g) => ({ id: g.group_id, name: g.name || g.group_id }));
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
    if (!shouldForward(text)) {
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
      // 5. Pesan 1: teruskan isi asli Telegram apa adanya ke SEMUA group aktif
      const forwardText = `[FORWARDED FROM TELEGRAM]\n\n${text}`;
      const hasil = [];
      for (const group of groups) {
        try {
          await this.queue.enqueue(
            () => this.wa.sendText(group.id, forwardText, []),
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

      // 6-10. Pesan 2: template + REAL WhatsApp mention.
      // Dijadwalkan, bukan dikirim langsung, agar peringatan yang terpecah
      // menjadi beberapa bagian hanya menghasilkan SATU pesan mention per group.
      this._scheduleFollowUp();

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
    const rendered = renderTemplate(template.content, users, {
      mentionDisplay: this.db.getSetting('mention_display', 'number'),
      count: pending.count,
    });

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

module.exports = Pipeline;
module.exports.KEYWORD = KEYWORD;
