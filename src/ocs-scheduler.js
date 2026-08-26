'use strict';

const logger = require('./logger').scope('OCS');
const OcsClient = require('./ocs-client');
const { renderReport, todayRange, jamLokal } = require('./ocs-report');

/**
 * Penjadwal laporan Fulfilment Dashboard.
 *
 * Setiap OCS_INTERVAL_MINUTES: tarik data dari OCS, susun satu pesan,
 * lalu kirim ke SEMUA WhatsApp Group yang aktif lewat antrean yang sama
 * dengan jalur Telegram (tidak ada pengiriman paralel).
 *
 * Tombol on/off ada di tabel settings (kunci: ocs_enabled) supaya bisa
 * diubah lewat Admin Menu tanpa mengedit .env.
 */
class OcsScheduler {
  constructor({ db, whatsapp, queue, config, notifyAdmins = null, client = null }) {
    this.db = db;
    this.wa = whatsapp;
    this.queue = queue;
    this.config = config;
    this.notifyAdmins = notifyAdmins;

    const o = config.ocs || {};
    this.opsi = o;
    this.client = client || new OcsClient({
      baseUrl: o.baseUrl,
      username: o.username,
      password: o.password,
      database: o.database,
      timeoutMs: o.timeoutMs,
    });

    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastOkAt = null;
    this.lastError = null;
    this.stats = { runs: 0, sent: 0, failed: 0, skipped: 0 };
  }

  /* ---------------------------- keadaan ---------------------------- */

  enabled() {
    const tersimpan = this.db ? this.db.getSetting('ocs_enabled', null) : null;
    if (tersimpan !== null && tersimpan !== undefined) return String(tersimpan) === '1';
    return this.opsi.enabled !== false;
  }

  setEnabled(on) {
    if (this.db) this.db.setSetting('ocs_enabled', on ? '1' : '0');
    logger.info('Laporan OCS', on ? 'DIAKTIFKAN' : 'DIMATIKAN');
  }

  /** Jam lokal saat ini berada di dalam rentang jam aktif? */
  dalamJamAktif(now = new Date()) {
    const rentang = this.opsi.activeHours;
    if (!rentang) return true;
    const lokal = new Date(now.getTime() + this.opsi.tzOffsetMinutes * 60000);
    const jam = lokal.getUTCHours();
    const { mulai, sampai } = rentang;
    if (mulai === sampai) return true;
    if (mulai < sampai) return jam >= mulai && jam < sampai;
    return jam >= mulai || jam < sampai;   // rentang melewati tengah malam
  }

  targetGroups() {
    return this.db.listActiveWaGroups().map((g) => ({ id: g.group_id, name: g.name || g.group_id }));
  }

  /* ---------------------------- penjadwal -------------------------- */

  start() {
    if (this.timer) return;
    const jeda = Math.max(60000, this.opsi.intervalMinutes * 60000);

    // Sejajarkan ke awal jam berikutnya supaya laporan datang di menit :00
    const sekarang = Date.now();
    const jedaAwal = this.opsi.alignToHour
      ? (3600000 - (sekarang % 3600000)) % 3600000 || 3600000
      : jeda;

    logger.info(
      `Laporan OCS dijadwalkan tiap ${this.opsi.intervalMinutes} menit` +
      (this.opsi.activeHours
        ? ` (jam aktif ${pad(this.opsi.activeHours.mulai)}:00-${pad(this.opsi.activeHours.sampai)}:00 ${this.opsi.tzLabel})`
        : ' (24 jam)') +
      `. Laporan pertama dalam ${Math.round(jedaAwal / 60000)} menit.`
    );

    const tick = () => {
      this.runOnce().catch((err) => logger.error('Laporan OCS gagal:', err.message));
    };

    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, jeda);
      if (this.timer.unref) this.timer.unref();
    }, jedaAwal);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* -------------------------- satu putaran ------------------------- */

  /**
   * @param {{paksa?: boolean}} opsi paksa=true mengabaikan tombol on/off,
   *   jam aktif, dan dipakai oleh perintah manual dari Admin Menu.
   * @returns {Promise<{status: string, reason?: string, text?: string, groups?: number}>}
   */
  async runOnce({ paksa = false } = {}) {
    if (this.running) {
      logger.warn('Putaran laporan sebelumnya belum selesai - putaran ini dilewati.');
      this.stats.skipped += 1;
      return { status: 'skipped', reason: 'sedang berjalan' };
    }
    if (!paksa && !this.enabled()) {
      this.stats.skipped += 1;
      return { status: 'skipped', reason: 'dimatikan' };
    }
    if (!paksa && !this.dalamJamAktif()) {
      this.stats.skipped += 1;
      logger.debug('Di luar jam aktif - laporan dilewati.');
      return { status: 'skipped', reason: 'di luar jam aktif' };
    }

    this.running = true;
    this.lastRunAt = Date.now();
    this.stats.runs += 1;

    try {
      const data = await this.ambilData();
      const teks = this.susunPesan(data);

      if (!paksa && this.opsi.onlyWhenProblem) {
        const { adaMasalah } = require('./ocs-report');
        if (!adaMasalah(data, this.opsi.ambang)) {
          this.stats.skipped += 1;
          logger.info('Tidak ada kondisi yang perlu dilaporkan - pesan tidak dikirim.');
          return { status: 'skipped', reason: 'tidak ada masalah', text: teks };
        }
      }

      const hasil = await this.kirim(teks);
      this.lastOkAt = Date.now();
      this.lastError = null;
      return { status: 'sent', text: teks, groups: hasil };
    } catch (err) {
      this.stats.failed += 1;
      this.lastError = err.message;
      logger.error('Laporan OCS gagal:', err.message);
      this._notify(`Laporan OCS gagal: ${err.message}`);
      return { status: 'failed', reason: err.message };
    } finally {
      this.running = false;
    }
  }

  async ambilData() {
    const { from, to } = todayRange(new Date(), this.opsi.tzOffsetMinutes);
    return this.client.fetchFulfilment({
      from,
      to,
      dateType: this.opsi.dateType,
      shop: this.opsi.shop,
      channel: this.opsi.channel,
      area: this.opsi.area,
      shift: this.opsi.shift,
      role: this.opsi.role,
    });
  }

  susunPesan(data) {
    return renderReport(data, {
      now: new Date(),
      tzOffsetMinutes: this.opsi.tzOffsetMinutes,
      tzLabel: this.opsi.tzLabel,
      topOperators: this.opsi.topOperators,
      judul: this.opsi.judul,
    });
  }

  async kirim(teks) {
    const groups = this.targetGroups();
    if (groups.length === 0) {
      throw new Error('belum ada WhatsApp Group aktif (buka /groups)');
    }
    if (!this.wa.isReady()) {
      throw new Error('WhatsApp belum tersambung');
    }

    let terkirim = 0;
    const gagal = [];
    for (const group of groups) {
      try {
        await this.queue.enqueue(
          () => this.wa.sendText(group.id, teks, []),
          `laporan OCS -> ${group.name}`
        );
        terkirim += 1;
      } catch (err) {
        gagal.push(`${group.name}: ${err.message}`);
        logger.error(`Laporan OCS gagal dikirim ke "${group.name}": ${err.message}`);
      }
    }

    if (terkirim === 0) throw new Error(`gagal ke seluruh group. ${gagal.join(' | ')}`);
    if (gagal.length > 0) this._notify(`Laporan OCS terkirim ke ${terkirim}/${groups.length} group. Gagal: ${gagal.join(' | ')}`);

    this.stats.sent += 1;
    logger.info(`Laporan OCS terkirim ke ${terkirim} group.`);
    return terkirim;
  }

  /** Ringkasan untuk /status di Admin Menu. */
  ringkasanStatus() {
    const off = this.opsi.tzOffsetMinutes;
    const baris = [];
    baris.push(`Laporan OCS: ${this.enabled() ? 'AKTIF' : 'MATI'}`);
    baris.push(`Jeda: ${this.opsi.intervalMinutes} menit`);
    baris.push(this.opsi.activeHours
      ? `Jam aktif: ${pad(this.opsi.activeHours.mulai)}:00-${pad(this.opsi.activeHours.sampai)}:00 ${this.opsi.tzLabel}`
      : 'Jam aktif: 24 jam');
    baris.push(`Terakhir dijalankan: ${this.lastRunAt ? jamLokal(new Date(this.lastRunAt), off, this.opsi.tzLabel) : '-'}`);
    baris.push(`Terakhir berhasil: ${this.lastOkAt ? jamLokal(new Date(this.lastOkAt), off, this.opsi.tzLabel) : '-'}`);
    baris.push(`Terkirim: ${this.stats.sent} | gagal: ${this.stats.failed} | dilewati: ${this.stats.skipped}`);
    if (this.lastError) baris.push(`Galat terakhir: ${this.lastError}`);
    return baris.join('\n');
  }

  _notify(text) {
    if (typeof this.notifyAdmins === 'function') {
      try { this.notifyAdmins(text); } catch (e) { /* diabaikan */ }
    }
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

module.exports = OcsScheduler;
