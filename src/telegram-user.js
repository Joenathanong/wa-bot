'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const logger = require('./logger').scope('TGUSER');

/**
 * PEMBACA TELEGRAM MODE AKUN (MTProto / GramJS).
 *
 * Dipakai ketika pesan peringatan dikirim oleh BOT LAIN di sebuah Grup.
 * Telegram tidak pernah mengirimkan pesan bot lain ke bot kita, sehingga
 * satu-satunya cara membacanya adalah dengan akun Telegram biasa.
 *
 * ==================  JAMINAN READ-ONLY  ==================
 * Modul ini HANYA memanggil operasi BACA: connect, getMe, addEventHandler,
 * iterDialogs, getEntity, getMessages, dan disconnect. Tidak ada sendMessage,
 * forwardMessages, joinChannel, inviteToChannel, editMessage, deleteMessages,
 * maupun markAsRead. Akun Anda tidak pernah mengirim apa pun, tidak pernah
 * bergabung ke mana pun, dan tidak pernah menandai pesan sudah dibaca.
 * =========================================================
 */

/** Ubah peer GramJS menjadi Chat ID gaya Bot API (-100xxx untuk supergroup). */
function toBotApiChatId(peer) {
  if (peer === null || peer === undefined) return null;

  // Sudah berupa angka/BigInt/string
  if (typeof peer === 'bigint' || typeof peer === 'number') return String(peer);
  if (typeof peer === 'string') return peer;

  const cls = peer.className || (peer.constructor && peer.constructor.name) || '';
  if (cls.includes('PeerChannel') || peer.channelId !== undefined) {
    return `-100${String(peer.channelId)}`;
  }
  if (cls.includes('PeerChat') || peer.chatId !== undefined) {
    return `-${String(peer.chatId)}`;
  }
  if (cls.includes('PeerUser') || peer.userId !== undefined) {
    return String(peer.userId);
  }
  return String(peer);
}

/**
 * Bandingkan dua Chat ID dengan toleransi bentuk:
 * "-1001234567890", "1234567890", dan "-1234567890" dianggap sama.
 */
function chatIdMatches(a, b) {
  const norm = (v) => String(v).replace(/^-100/, '').replace(/^-/, '');
  return String(a) === String(b) || norm(a) === norm(b);
}

class TelegramUserSource extends EventEmitter {
  constructor({ config, pipeline, onStatus = null, healthCheckMs = 60000, isReady = null }) {
    super();
    this.config = config;
    this.pipeline = pipeline;
    this.onStatus = onStatus;
    this.healthCheckMs = healthCheckMs;
    // Susulan tidak ada gunanya bila WhatsApp belum siap: pesannya akan
    // gagal dikirim dan (dengan benar) tidak ditandai terproses. Jadi kita
    // tunda dulu, lalu ulangi begitu WhatsApp siap.
    this.isReady = isReady;
    this.catchUpTertunda = false;
    this.client = null;
    this.connected = false;
    this.me = null;
    this.state = 'stopped'; // stopped | connecting | connected | no_session | failed
    this.lastError = null;
    this.seen = 0;
    this.reconnects = 0;
    this.caughtUp = 0;
    this.lastEventAt = 0;
    this.lastHealthyAt = 0;
    this.pingMs = null;
    this.slowPings = 0;
    this.failedPings = 0;
    this._watchTimer = null;
    this._stopping = false;
    this._restarting = false;
  }

  sessionFile() {
    return this.config.telegramUser.sessionFile;
  }

  readSession() {
    try {
      const raw = fs.readFileSync(this.sessionFile(), 'utf8').trim();
      return raw || '';
    } catch (err) {
      return '';
    }
  }

  async start() {
    if (this.client && this.connected) return true;   // sudah jalan
    this._stopping = false;
    const session = this.readSession();
    if (!session) {
      this.state = 'no_session';
      logger.error('Belum ada sesi akun Telegram. Jalankan dulu: npm run tg:login');
      return false;
    }

    let TelegramClient;
    let StringSession;
    let NewMessage;
    try {
      ({ TelegramClient } = require('telegram'));
      ({ StringSession } = require('telegram/sessions'));
      ({ NewMessage } = require('telegram/events'));
    } catch (err) {
      this.state = 'failed';
      this.lastError = err.message;
      logger.error('Library GramJS belum terpasang. Jalankan: npm install');
      return false;
    }

    this.state = 'connecting';
    const tu = this.config.telegramUser;
    this.clientOptions = {
      useWSS: tu.useWSS !== false,
      connectionRetries: tu.connectionRetries || 100,
      retryDelay: tu.retryDelay || 3000,
      requestRetries: tu.requestRetries || 5,
      autoReconnect: true,
    };
    this.client = new TelegramClient(
      new StringSession(session),
      tu.apiId,
      tu.apiHash,
      this.clientOptions
    );
    try { this.client.setLogLevel(tu.logLevel || 'error'); } catch (e) { /* versi lama */ }
    logger.info(
      'Transport:', this.clientOptions.useWSS ? 'WSS (port 443, ramah firewall)' : 'TCP polos (port 80)'
    );

    try {
      await this.client.connect();
      this.me = await this.client.getMe();
      this.connected = true;
      this.state = 'connected';
      const who = this.me ? (this.me.username ? '@' + this.me.username : this.me.firstName) : '(tidak diketahui)';
      logger.info(`Terhubung sebagai akun Telegram ${who} - MODE BACA SAJA`);
    } catch (err) {
      this.state = 'failed';
      this.lastError = err.message;
      logger.error('Gagal terhubung ke Telegram dengan akun:', err.message);
      logger.error('Bila sesi kedaluwarsa, jalankan ulang: npm run tg:login');
      return false;
    }

    this.client.addEventHandler(
      (event) => this._onEvent(event).catch((e) => logger.error('Error memproses pesan:', e.message)),
      new NewMessage({})
    );

    logger.info('Mendengarkan pesan masuk (termasuk pesan dari bot lain).');
    if (this.config.telegram.allowedChatIds.length === 0) {
      logger.warn('TELEGRAM_ALLOWED_CHAT_IDS kosong - semua chat akan diproses. Jalankan: npm run tg:chats');
    }

    this.lastHealthyAt = Date.now();
    this._startWatchdog();
    this.emit('up');

    // Susulan: proses pesan yang masuk selagi aplikasi/jaringan mati.
    await this.catchUp();
    return true;
  }

  /* ----------------------- pemantauan koneksi ----------------------- */

  _startWatchdog() {
    if (this._watchTimer || this.healthCheckMs <= 0) return;
    this._watchTimer = setInterval(() => {
      this._checkHealth().catch((err) => logger.warn('Pemeriksaan koneksi gagal:', err.message));
    }, this.healthCheckMs);
    if (this._watchTimer.unref) this._watchTimer.unref();
  }

  _stopWatchdog() {
    if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
  }

  /**
   * Dipanggil berkala. GramJS bisa "diam" setelah jaringan putus lama
   * (PC tidur, internet mati) tanpa melempar error apa pun, sehingga
   * pesan baru tidak pernah sampai. Ping ringan memastikan koneksi hidup.
   */
  async _checkHealth() {
    if (this._stopping || this._restarting || !this.client) return;

    let looksConnected = true;
    try {
      if (this.client.connected === false) looksConnected = false;
    } catch (e) { /* properti tidak ada di versi tertentu */ }

    if (!looksConnected) {
      logger.warn('Koneksi akun Telegram terputus - menyambung ulang.');
      return this.restart('terputus');
    }

    const t0 = Date.now();
    try {
      await this.client.getMe();
      this.pingMs = Date.now() - t0;
      this.lastHealthyAt = Date.now();

      if (this.pingMs > 5000) {
        this.slowPings += 1;
        logger.warn(
          `Koneksi ke Telegram lambat: ${this.pingMs} ms. ` +
          (this.clientOptions && this.clientOptions.useWSS
            ? 'Jaringan sedang padat atau firewall menahan trafik.'
            : 'Coba TELEGRAM_USE_WSS=true di .env agar memakai port 443.')
        );
      }
      if (!this.connected) { this.connected = true; this.state = 'connected'; this.emit('up'); }
    } catch (err) {
      this.failedPings += 1;
      this.pingMs = null;
      logger.warn('Ping ke Telegram gagal (' + err.message + ') - menyambung ulang.');
      return this.restart('ping gagal');
    }
  }

  /** Bangun ulang koneksi dari nol, lalu susulkan pesan yang terlewat. */
  async restart(reason = 'manual') {
    if (this._stopping || this._restarting) return false;
    this._restarting = true;
    this.reconnects += 1;
    this.connected = false;
    this.state = 'connecting';
    this.emit('down', reason);
    logger.warn(`Menyambung ulang akun Telegram (${reason}), percobaan ke-${this.reconnects}`);

    this._stopWatchdog();
    try { if (this.client) await this.client.disconnect(); } catch (e) { /* abaikan */ }
    try { if (this.client) await this.client.destroy(); } catch (e) { /* abaikan */ }
    this.client = null;
    this._restarting = false;

    const ok = await this.start();
    if (!ok) {
      logger.error('Gagal menyambung ulang. Akan dicoba lagi pada pemeriksaan berikutnya.');
      this._startWatchdog();
    }
    return ok;
  }

  /* --------------------------- susulan ------------------------------ */

  /**
   * Ambil pesan terakhir dari tiap chat yang diizinkan lalu jalankan
   * melalui pipeline. Proteksi duplikat di database memastikan pesan yang
   * sudah pernah diteruskan tidak dikirim dua kali, jadi aman dipanggil
   * setiap kali koneksi pulih maupun setiap aplikasi dijalankan.
   *
   * MODE "hanya yang terakhir" (CATCHUP_ONLY_LATEST=true, bawaan):
   * setelah mati listrik / restart, hanya SATU pesan per chat yang dikirim,
   * yaitu pesan TERBARU yang memenuhi kriteria dan belum pernah terkirim.
   * Peringatan lama yang juga memenuhi kriteria ditandai terproses supaya
   * tidak membanjiri WhatsApp Group dengan data yang sudah basi.
   */
  async catchUp(options = {}) {
    const limit = Number(options.limit || this.config.catchUp.limit);
    const maxAgeMinutes = Number(options.maxAgeMinutes || this.config.catchUp.maxAgeMinutes);
    const hanyaTerakhir = options.onlyLatest !== undefined
      ? Boolean(options.onlyLatest)
      : this.config.catchUp.onlyLatest !== false;
    if (limit <= 0 || maxAgeMinutes <= 0) return 0;

    const chats = this.config.telegram.allowedChatIds;
    if (chats.length === 0) {
      logger.warn('Susulan dilewati: TELEGRAM_ALLOWED_CHAT_IDS kosong.');
      return 0;
    }
    if (!this.client) return 0;

    if (typeof this.isReady === 'function' && !this.isReady()) {
      this.catchUpTertunda = true;
      logger.info('Susulan DITUNDA: WhatsApp belum siap. Akan diulang otomatis begitu WhatsApp ready.');
      return 0;
    }
    this.catchUpTertunda = false;

    const cutoff = Date.now() - maxAgeMinutes * 60000;
    let forwarded = 0;
    let scanned = 0;
    let dilewati = 0;

    for (const chatId of chats) {
      try {
        const entity = await this._resolveEntity(chatId);
        const messages = await this.client.getMessages(entity, { limit });
        const ordered = (messages || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0));

        // 1. Kumpulkan calon: ada teksnya, masih dalam rentang umur,
        //    memenuhi kriteria keyword, dan belum pernah diteruskan.
        const calon = [];
        for (const m of ordered) {
          const text = (m && (m.message || m.text)) || '';
          if (!text) continue;
          scanned += 1;
          const ts = m.date ? Number(m.date) * 1000 : 0;
          if (ts && ts < cutoff) continue;
          if (!this.pipeline.layakDiteruskan(chatId, m.id, text)) continue;
          calon.push({ id: m.id, text });
        }
        if (calon.length === 0) continue;

        // 2. Hanya pesan TERAKHIR yang dikirim. Sisanya ditandai terproses
        //    supaya tidak muncul lagi di susulan berikutnya.
        let akanDikirim = calon;
        if (hanyaTerakhir && calon.length > 1) {
          const lama = calon.slice(0, -1);
          for (const c of lama) {
            this.pipeline.lewati(chatId, c.id, 'susulan - bukan peringatan terakhir');
            dilewati += 1;
          }
          akanDikirim = calon.slice(-1);
          logger.info(
            `Susulan chat ${chatId}: ${calon.length} peringatan tertinggal, ` +
            `hanya yang terakhir (msg ${akanDikirim[0].id}) yang dikirim.`
          );
        }

        for (const c of akanDikirim) {
          const res = await this.pipeline.handle({ chatId, messageId: c.id, text: c.text, source: 'catchup' });
          if (res && res.action === 'forwarded') forwarded += 1;
        }
      } catch (err) {
        logger.warn(`Susulan untuk chat ${chatId} gagal: ${err.message}`);
      }
    }

    this.caughtUp += forwarded;
    const ekor = dilewati > 0 ? ` ${dilewati} peringatan lama dilewati (hanya yang terakhir dikirim).` : '';
    if (forwarded > 0) {
      logger.info(`Susulan: ${forwarded} pesan tertinggal ikut diteruskan (dari ${scanned} pesan diperiksa).${ekor}`);
      this.emit('caught-up', forwarded);
    } else {
      logger.info(`Susulan: tidak ada pesan tertinggal (${scanned} pesan diperiksa).${ekor}`);
    }
    return forwarded;
  }

  /** Ubah Chat ID gaya Bot API menjadi entity yang dipahami GramJS. */
  async _resolveEntity(chatId) {
    const raw = String(chatId);
    const candidates = [];
    if (/^-?\d+$/.test(raw)) {
      candidates.push(Number(raw));
      try { candidates.push(BigInt(raw)); } catch (e) { /* abaikan */ }
      if (raw.startsWith('-100')) {
        const bare = raw.slice(4);
        candidates.push(Number(bare));
        try { candidates.push(BigInt(bare)); } catch (e) { /* abaikan */ }
      }
    }
    candidates.push(raw);

    let lastError = null;
    for (const c of candidates) {
      try {
        const entity = await this.client.getEntity(c);
        if (entity) return entity;
      } catch (err) { lastError = err; }
    }
    throw lastError || new Error(`Chat ${raw} tidak ditemukan`);
  }

  async _onEvent(event) {
    const msg = event && event.message;
    if (!msg) return;

    const text = msg.message || msg.text || '';
    if (!text) return;

    const chatId = toBotApiChatId(msg.peerId !== undefined ? msg.peerId : event.chatId);
    if (chatId === null) return;

    this.seen += 1;
    this.lastEventAt = Date.now();
    this.lastHealthyAt = Date.now();

    // Cocokkan allowlist dengan toleransi bentuk (-100... vs ...)
    const allowed = this.config.telegram.allowedChatIds;
    if (allowed.length > 0 && !allowed.some((a) => chatIdMatches(a, chatId))) {
      logger.debug(`Diabaikan: chat ${chatId} tidak ada di TELEGRAM_ALLOWED_CHAT_IDS`);
      return;
    }

    await this.pipeline.handle({
      chatId,
      messageId: msg.id,
      text,
      source: 'user',
    });
  }

  /** Daftar chat untuk membantu menemukan Chat ID grup sumber. */
  async listChats(limit = 100) {
    if (!this.client) throw new Error('Belum terhubung');
    const out = [];
    for await (const dialog of this.client.iterDialogs({ limit })) {
      out.push({
        id: toBotApiChatId(dialog.entity && dialog.entity.id !== undefined
          ? (dialog.isChannel || dialog.isGroup ? { channelId: dialog.entity.id, className: 'PeerChannel' } : dialog.entity.id)
          : dialog.id),
        rawId: String(dialog.id),
        title: dialog.title || dialog.name || '(tanpa nama)',
        isGroup: !!dialog.isGroup,
        isChannel: !!dialog.isChannel,
        isUser: !!dialog.isUser,
      });
    }
    return out;
  }

  async stop() {
    this._stopping = true;
    this._stopWatchdog();
    if (this.client) {
      try { await this.client.disconnect(); } catch (e) { /* ignore */ }
      try { await this.client.destroy(); } catch (e) { /* ignore */ }
    }
    this.client = null;
    this.connected = false;
    this.state = 'stopped';
  }

  status() {
    return {
      state: this.state,
      connected: this.connected,
      account: this.me ? (this.me.username ? '@' + this.me.username : this.me.firstName) : null,
      seen: this.seen,
      reconnects: this.reconnects,
      pingMs: this.pingMs,
      slowPings: this.slowPings,
      failedPings: this.failedPings,
      transport: this.clientOptions && this.clientOptions.useWSS ? 'WSS/443' : 'TCP/80',
      caughtUp: this.caughtUp,
      catchUpTertunda: this.catchUpTertunda,
      lastEventAt: this.lastEventAt,
      lastHealthyAt: this.lastHealthyAt,
      lastError: this.lastError,
      sessionFile: this.sessionFile(),
    };
  }
}

module.exports = TelegramUserSource;
module.exports.toBotApiChatId = toBotApiChatId;
module.exports.chatIdMatches = chatIdMatches;
