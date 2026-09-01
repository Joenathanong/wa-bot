'use strict';

const crypto = require('crypto');
const logger = require('./logger').scope('LOCK');
const OcsClient = require('./ocs-client');
const L = require('./lock-report');
const { validateWhatsappNumber } = require('./render');

/**
 * Penjadwal peringatan LOCK STOCK.
 *
 * Berdiri sendiri: penjadwal, pengaturan, dan perintah Telegram terpisah
 * dari jalur forward Telegram maupun dari laporan OCS/stok. Yang dipakai
 * bersama hanya sesi WhatsApp dan ANTREAN pengiriman - WhatsApp hanya
 * mengizinkan satu sesi per nomor, dan antrean bersama itulah yang
 * menjamin tidak pernah ada dua pengiriman berbarengan.
 *
 * ===================== JEDA ACAK =====================
 * Permintaan yang jatuh di detik yang sama persis tiap jam adalah pola
 * mesin yang paling mudah dikenali. Karena itu setiap putaran menjadwalkan
 * putaran BERIKUTNYA sendiri pada:
 *
 *     jeda +/- acak(0..jitter menit) +/- acak(0..59 detik)
 *
 * Angka acaknya dari crypto.randomInt, bukan Math.random, supaya tidak
 * membentuk deret yang bisa ditebak. Jeda tidak pernah menjadi lebih
 * pendek dari satu menit.
 * =====================================================
 */

const KUNCI = {
  enabled: 'lock_enabled',
  interval: 'lock_interval',
  jitter: 'lock_jitter',
  groups: 'lock_groups',
  pic: 'lock_pic',
  onlyOnChange: 'lock_only_on_change',
  sidikJari: 'lock_fingerprint',
};

class LockScheduler {
  constructor({ db, whatsapp, queue, config, notifyAdmins = null, client = null }) {
    this.db = db;
    this.wa = whatsapp;
    this.queue = queue;
    this.config = config;
    this.notifyAdmins = notifyAdmins;

    this.dasar = config.lock || {};
    const c = config.ocs || {};
    this.client = client || new OcsClient({
      baseUrl: c.baseUrl,
      username: c.username,
      password: c.password,
      database: c.database,
      timeoutMs: c.timeoutMs,
    });

    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastOkAt = null;
    this.nextRunAt = null;
    this.lastError = null;
    this.lastRingkasan = '-';
    this.stats = { runs: 0, sent: 0, failed: 0, skipped: 0, alerts: 0 };
    this._rack = null;          // {waktu, peta}
  }

  /* --------------------------- pengaturan --------------------------- */

  _setting(kunci, bawaan) {
    if (!this.db) return bawaan;
    const v = this.db.getSetting(kunci, null);
    return (v === null || v === undefined || v === '') ? bawaan : v;
  }

  opsi() {
    const d = this.dasar;
    const c = this.config.ocs || {};
    return {
      intervalMinutes: Math.max(5, parseInt(this._setting(KUNCI.interval, d.intervalMinutes), 10) || 60),
      jitterMinutes: Math.max(0, parseInt(this._setting(KUNCI.jitter, d.jitterMinutes), 10) || 0),
      groupIds: String(this._setting(KUNCI.groups, d.groupIds.join(',')))
        .split(',').map((s) => s.trim()).filter(Boolean),
      onlyOnChange: String(this._setting(KUNCI.onlyOnChange, d.onlyOnChange ? '1' : '0')) === '1',
      activeHours: d.activeHours,
      shops: d.shops,
      hanyaAktif: d.hanyaAktif,
      kategori: d.kategori,
      area: d.area,
      monospace: d.monospace,
      maxSku: d.maxSku,
      maxBaris: d.maxBaris,
      rackCacheMinutes: d.rackCacheMinutes,
      tzOffsetMinutes: c.tzOffsetMinutes || 420,
      tzLabel: c.tzLabel || 'WIB',
    };
  }

  /** PIC tiap shop: {NCO: {nama, nomor}, ...} */
  picMap() {
    const hasil = {};
    for (const shop of this.dasar.shops || L.SHOP_BAWAAN) {
      hasil[shop] = { nama: L.PIC_BAWAAN[shop] || 'Tim', nomor: '' };
    }
    try {
      const mentah = this._setting(KUNCI.pic, '');
      if (mentah) {
        const tersimpan = JSON.parse(mentah);
        for (const [shop, isi] of Object.entries(tersimpan || {})) {
          hasil[shop] = { ...(hasil[shop] || {}), ...isi };
        }
      }
    } catch (err) {
      logger.warn('Pengaturan PIC rusak, memakai bawaan:', err.message);
    }
    return hasil;
  }

  _simpanPic(peta) {
    if (this.db) this.db.setSetting(KUNCI.pic, JSON.stringify(peta));
  }

  /** Cocokkan nama shop tanpa peduli besar-kecil huruf. */
  _cariShop(nama) {
    const cari = String(nama || '').trim().toLowerCase();
    const daftar = [...(this.dasar.shops || L.SHOP_BAWAAN), L.TANPA_SHOP];
    return daftar.find((s) => s.toLowerCase() === cari) || null;
  }

  setPicNama(shop, nama) {
    const s = this._cariShop(shop);
    if (!s) throw new Error(`shop "${shop}" tidak dikenal. Pilihan: ${this.dasar.shops.join(', ')}`);
    const teks = String(nama || '').trim();
    if (!teks) throw new Error('nama PIC tidak boleh kosong');
    const peta = this.picMap();
    peta[s] = { ...(peta[s] || {}), nama: teks };
    this._simpanPic(peta);
    return `PIC ${s}: ${teks}`;
  }

  setPicNomor(shop, nomor) {
    const s = this._cariShop(shop);
    if (!s) throw new Error(`shop "${shop}" tidak dikenal. Pilihan: ${this.dasar.shops.join(', ')}`);
    const peta = this.picMap();
    const kosong = String(nomor || '').trim() === '' || /^(hapus|kosong|-)$/i.test(String(nomor).trim());
    if (kosong) {
      peta[s] = { ...(peta[s] || {}), nomor: '' };
      this._simpanPic(peta);
      return `Nomor PIC ${s} dihapus - namanya tetap disapa, tetapi tanpa mention.`;
    }
    const cek = validateWhatsappNumber(nomor);
    if (!cek.ok) throw new Error(cek.error);
    peta[s] = { ...(peta[s] || {}), nomor: cek.value };
    this._simpanPic(peta);
    return `Nomor PIC ${s}: ${cek.value} (akan di-mention sungguhan)`;
  }

  setOpsi(nama, nilai) {
    if (nama === 'interval' || nama === 'jitter') {
      const n = parseInt(String(nilai).trim(), 10);
      if (!Number.isFinite(n) || n < 0) throw new Error('isi dengan angka menit');
      if (nama === 'interval' && n < 5) throw new Error('jeda minimal 5 menit');
      this.db.setSetting(KUNCI[nama], String(n));
      return nama === 'interval' ? `Jeda: ${n} menit` : `Penyimpangan acak: +/- ${n} menit`;
    }
    if (nama === 'groups') {
      const daftar = String(nilai || '').split(',').map((s) => s.trim()).filter(Boolean);
      this.db.setSetting(KUNCI.groups, daftar.join(','));
      return daftar.length === 0 ? 'Group tujuan: SEMUA group aktif' : `Group tujuan: ${daftar.join(', ')}`;
    }
    if (nama === 'onlyOnChange') {
      const on = /^(1|true|on|ya)$/i.test(String(nilai).trim());
      this.db.setSetting(KUNCI.onlyOnChange, on ? '1' : '0');
      return on
        ? 'Hanya kirim bila daftar SKU BERUBAH - pesan identik tiap jam tidak diulang.'
        : 'Kirim setiap putaran, walau daftar SKU-nya sama.';
    }
    throw new Error(`pengaturan "${nama}" tidak dikenal`);
  }

  enabled() {
    const v = this.db ? this.db.getSetting(KUNCI.enabled, null) : null;
    if (v !== null && v !== undefined && v !== '') return String(v) === '1';
    return this.dasar.enabled === true;
  }

  setEnabled(on) {
    if (this.db) this.db.setSetting(KUNCI.enabled, on ? '1' : '0');
    logger.info('Peringatan lock stock', on ? 'DIAKTIFKAN' : 'DIMATIKAN');
  }

  dalamJamAktif(now = new Date()) {
    const o = this.opsi();
    if (!o.activeHours) return true;
    const lokal = new Date(now.getTime() + o.tzOffsetMinutes * 60000);
    const jam = lokal.getUTCHours();
    const { mulai, sampai } = o.activeHours;
    if (mulai === sampai) return true;
    if (mulai < sampai) return jam >= mulai && jam < sampai;
    return jam >= mulai || jam < sampai;
  }

  /* ---------------------------- penjadwal --------------------------- */

  /**
   * Jeda sampai putaran berikutnya, dalam milidetik.
   * Acak simetris di sekitar jeda dasar, memakai crypto.randomInt.
   */
  jedaBerikutnya() {
    const o = this.opsi();
    const dasar = o.intervalMinutes * 60000;
    const jitter = o.jitterMinutes * 60000;
    let geser = 0;
    if (jitter > 0) geser = crypto.randomInt(-jitter, jitter + 1);
    const detik = crypto.randomInt(0, 60) * 1000;
    return Math.max(60000, dasar + geser + detik);
  }

  start() {
    if (this.timer) return;
    const o = this.opsi();
    logger.info(
      `Peringatan lock stock dijadwalkan tiap ${o.intervalMinutes} menit `
      + `(acak +/- ${o.jitterMinutes} menit)`
      + (o.activeHours ? `, jam aktif ${o.activeHours.mulai}:00-${o.activeHours.sampai}:00 ${o.tzLabel}` : ', 24 jam')
      + '.'
    );
    this._jadwalkan();
  }

  _jadwalkan() {
    const jeda = this.jedaBerikutnya();
    this.nextRunAt = Date.now() + jeda;
    logger.debug(`Pemeriksaan lock stock berikutnya dalam ${Math.round(jeda / 60000)} menit.`);
    this.timer = setTimeout(() => {
      this.runOnce()
        .catch((err) => logger.error('Pemeriksaan lock stock gagal:', err.message))
        .finally(() => { if (this.timer) this._jadwalkan(); });
    }, jeda);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.nextRunAt = null;
  }

  /* -------------------------- satu putaran -------------------------- */

  async runOnce({ paksa = false } = {}) {
    if (this.running) {
      this.stats.skipped += 1;
      logger.warn('Pemeriksaan sebelumnya belum selesai - putaran ini dilewati.');
      return { status: 'skipped', reason: 'sedang berjalan' };
    }
    if (!paksa && !this.enabled()) {
      this.stats.skipped += 1;
      return { status: 'skipped', reason: 'dimatikan' };
    }
    if (!paksa && !this.dalamJamAktif()) {
      this.stats.skipped += 1;
      return { status: 'skipped', reason: 'di luar jam aktif' };
    }

    this.running = true;
    this.lastRunAt = Date.now();
    this.stats.runs += 1;
    try {
      const { grup } = await this.periksa();
      this.lastRingkasan = L.ringkasan(grup);

      if (grup.size === 0) {
        this.lastOkAt = Date.now();
        this.lastError = null;
        if (this.db) this.db.setSetting(KUNCI.sidikJari, '');
        logger.info('Tidak ada SKU yang ter-lock. Aman.');
        return { status: 'clear', reason: 'tidak ada SKU ter-lock' };
      }

      const sidik = this.sidikJari(grup);
      if (!paksa && this.opsi().onlyOnChange && this.db
          && this.db.getSetting(KUNCI.sidikJari, '') === sidik) {
        this.stats.skipped += 1;
        logger.info(`Daftar SKU ter-lock tidak berubah (${this.lastRingkasan}) - pesan tidak diulang.`);
        return { status: 'skipped', reason: 'tidak ada perubahan', ringkasan: this.lastRingkasan };
      }

      const pesan = this.susunPesan(grup);
      const hasil = await this.kirim(pesan);
      if (this.db) this.db.setSetting(KUNCI.sidikJari, sidik);
      this.lastOkAt = Date.now();
      this.lastError = null;
      return {
        status: 'sent', pesan, groups: hasil.groups,
        alerts: pesan.length, ringkasan: this.lastRingkasan,
      };
    } catch (err) {
      this.stats.failed += 1;
      this.lastError = err.message;
      logger.error('Peringatan lock stock gagal:', err.message);
      this._notify(`Peringatan lock stock gagal: ${err.message}`);
      return { status: 'failed', reason: err.message };
    } finally {
      this.running = false;
    }
  }

  /** Tarik data lalu kelompokkan per shop. Tidak mengirim apa pun. */
  async periksa() {
    const o = this.opsi();
    const stok = await this.client.fetchUnderReserve({
      hanyaAktif: o.hanyaAktif, kategori: o.kategori, area: o.area,
    });
    const terkunci = L.saringTerkunci(stok);
    logger.info(`OCS mengembalikan ${stok.length} baris, ${terkunci.length} benar-benar ter-lock.`);

    if (terkunci.length === 0) return { terkunci, grup: new Map() };

    const peta = await this.petaShop();
    const grup = L.kelompokkanPerShop(terkunci, peta, o.shops);
    return { terkunci, grup };
  }

  /** Master Sku Rack, disimpan sementara supaya tidak ditarik tiap jam. */
  async petaShop() {
    const o = this.opsi();
    const umur = o.rackCacheMinutes * 60000;
    if (this._rack && Date.now() - this._rack.waktu < umur) return this._rack.peta;
    const rack = await this.client.fetchSkuRack();
    const peta = L.petaShop(rack);
    this._rack = { waktu: Date.now(), peta };
    logger.info(`Master Sku Rack: ${rack.length} baris, ${peta.size} SKU dipetakan ke shop.`);
    return peta;
  }

  /**
   * Sidik jari isi peringatan - dipakai untuk mode "hanya bila berubah".
   * Ikut memuat angkanya, sehingga jumlah reserve yang bertambah tetap
   * dianggap perubahan walau daftar SKU-nya sama.
   */
  sidikJari(grup) {
    const bagian = [];
    for (const [shop, baris] of grup) {
      for (const b of baris) bagian.push(`${shop}|${b.sku}|${b.resv}|${b.avail}`);
    }
    return crypto.createHash('sha1').update(bagian.sort().join('\n')).digest('hex');
  }

  /** Satu pesan per shop. */
  susunPesan(grup) {
    const o = this.opsi();
    const pic = this.picMap();
    const pesan = [];
    for (const [shop, semua] of grup) {
      const baris = semua.slice(0, o.maxBaris);
      const sisa = semua.length - baris.length;
      const hasil = L.renderLockAlert(
        { shop, baris, pic: pic[shop] || { nama: 'Tim' } },
        {
          now: new Date(), tzOffsetMinutes: o.tzOffsetMinutes, tzLabel: o.tzLabel,
          monospace: o.monospace, maxSku: o.maxSku,
        }
      );
      if (sisa > 0) hasil.text += `\n\n_...dan ${sisa} SKU lain di shop ini._`;
      pesan.push(hasil);
    }
    return pesan;
  }

  targetGroups() {
    const pilihan = this.opsi().groupIds;
    if (pilihan.length === 0) {
      return this.db.listActiveWaGroups().map((g) => ({ id: g.group_id, name: g.name || g.group_id }));
    }
    const semua = this.db.listWaGroups().map((g) => ({ id: g.group_id, name: g.name || g.group_id }));
    const hasil = [];
    const tidakDikenal = [];
    for (const p of pilihan) {
      const cocok = semua.find((g) => g.id === p || String(g.name).toLowerCase() === p.toLowerCase());
      if (cocok) hasil.push(cocok);
      else if (/@g\.us$/i.test(p)) hasil.push({ id: p, name: p });
      else tidakDikenal.push(p);
    }
    this._groupTidakDikenal = tidakDikenal;
    return hasil;
  }

  async kirim(pesan) {
    const groups = this.targetGroups();
    if (groups.length === 0) {
      if (this._groupTidakDikenal && this._groupTidakDikenal.length > 0) {
        throw new Error(`tujuan tidak dikenal: ${this._groupTidakDikenal.join(', ')}. `
          + 'Isi dengan JID (contoh 1203...@g.us) atau nama group yang terdaftar di /groups.');
      }
      throw new Error('belum ada WhatsApp Group aktif (buka /groups)');
    }
    if (!this.wa.isReady()) throw new Error('WhatsApp belum tersambung');

    let terkirim = 0;
    const gagal = [];
    for (const group of groups) {
      for (const p of pesan) {
        try {
          await this.queue.enqueue(
            () => this.wa.sendText(group.id, p.text, p.mentions),
            `lock stock ${p.shop} -> ${group.name}`
          );
          terkirim += 1;
        } catch (err) {
          gagal.push(`${group.name}/${p.shop}: ${err.message}`);
          logger.error(`Peringatan ${p.shop} gagal dikirim ke "${group.name}": ${err.message}`);
        }
      }
    }
    if (terkirim === 0) throw new Error(`gagal ke seluruh group. ${gagal.join(' | ')}`);
    if (gagal.length > 0) this._notify(`Peringatan lock stock sebagian gagal: ${gagal.join(' | ')}`);
    this.stats.sent += 1;
    this.stats.alerts += terkirim;
    logger.info(`Peringatan lock stock terkirim: ${terkirim} pesan ke ${groups.length} group (${this.lastRingkasan}).`);
    return { groups: groups.length, pesan: terkirim };
  }

  ringkasanStatus() {
    const o = this.opsi();
    const pic = this.picMap();
    const jam = (t) => {
      if (!t) return '-';
      const l = new Date(t + o.tzOffsetMinutes * 60000);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(l.getUTCHours())}:${p(l.getUTCMinutes())} ${o.tzLabel}`;
    };
    const B = [];
    B.push(`Lock stock: ${this.enabled() ? 'AKTIF' : 'MATI'}`);
    B.push(`Jeda: ${o.intervalMinutes} menit, acak +/- ${o.jitterMinutes} menit`);
    B.push(o.activeHours ? `Jam aktif: ${o.activeHours.mulai}:00-${o.activeHours.sampai}:00` : 'Jam aktif: 24 jam');
    B.push(`Group tujuan: ${o.groupIds.length === 0 ? 'semua group aktif' : o.groupIds.join(', ')}`);
    B.push(`Ulangi pesan yang sama: ${o.onlyOnChange ? 'TIDAK (hanya bila berubah)' : 'ya, tiap putaran'}`);
    B.push('');
    B.push('PIC per shop:');
    for (const [shop, isi] of Object.entries(pic)) {
      B.push(`  ${shop}: ${isi.nama}${isi.nomor ? ` (@${isi.nomor})` : ' - belum ada nomor, tanpa mention'}`);
    }
    B.push('');
    B.push(`Terakhir diperiksa: ${jam(this.lastRunAt)}`);
    B.push(`Terakhir berhasil: ${jam(this.lastOkAt)}`);
    B.push(`Pemeriksaan berikutnya: ${jam(this.nextRunAt)}`);
    B.push(`Temuan terakhir: ${this.lastRingkasan}`);
    B.push(`Terkirim: ${this.stats.sent} putaran / ${this.stats.alerts} pesan | gagal: ${this.stats.failed} | dilewati: ${this.stats.skipped}`);
    if (this.lastError) B.push(`Galat terakhir: ${this.lastError}`);
    return B.join('\n');
  }

  _notify(text) {
    if (typeof this.notifyAdmins === 'function') {
      try { this.notifyAdmins(text); } catch (e) { /* diabaikan */ }
    }
  }
}

module.exports = LockScheduler;
module.exports.KUNCI = KUNCI;
