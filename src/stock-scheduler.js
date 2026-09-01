'use strict';

const logger = require('./logger').scope('STOK');
const OcsClient = require('./ocs-client');
const {
  renderStockReport, rentangPenjualan, daftarHari, daftarHariGabungan, deretHarian,
  saringStok, saringDoi, susunBaris, kunciHari, jamLokal, angka, kriteria,
} = require('./stock-report');
const { normalisasiPic } = require('./lock-report');
const { validateWhatsappNumber } = require('./render');

/**
 * Penjadwal laporan "Stok Menipis".
 *
 * Berbeda dengan laporan Fulfilment yang berjalan tiap sekian menit,
 * laporan ini terkirim pada JAM TERTENTU saja (bawaan 08, 12, 16 waktu
 * lokal). Penjadwal berdetak tiap menit lalu memeriksa apakah jam sekarang
 * termasuk jam kirim dan belum pernah terkirim pada jam itu hari ini.
 *
 * Semua pengaturan (jam, ambang, jumlah SKU, group tujuan, mode rata-rata)
 * dibaca dari tabel settings lebih dulu, baru jatuh ke .env. Dengan begitu
 * Menu Admin Telegram bisa mengubahnya tanpa mengedit berkas dan tanpa
 * me-restart service.
 */

const KUNCI = {
  enabled: 'stock_enabled',
  hours: 'stock_hours',
  ambang: 'stock_threshold',
  top: 'stock_top',
  groups: 'stock_groups',
  avgMode: 'stock_avg_mode',
  salesDays: 'stock_sales_days',
  kategori: 'stock_category',
  doiMax: 'stock_doi_max',
  minAvg: 'stock_min_avg',
  pic: 'stock_pic',
  lastFired: 'stock_last_fired',
};

class StockScheduler {
  constructor({ db, whatsapp, queue, config, notifyAdmins = null, client = null }) {
    this.db = db;
    this.wa = whatsapp;
    this.queue = queue;
    this.config = config;
    this.notifyAdmins = notifyAdmins;

    const o = config.stock || {};
    this.dasar = o;
    const c = config.ocs || {};
    this.client = client || new OcsClient({
      baseUrl: c.baseUrl,
      username: c.username,
      password: c.password,
      database: c.database,
      timeoutMs: Math.max(60000, c.timeoutMs || 20000),   // laporan 30 hari besar
    });

    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.lastOkAt = null;
    this.lastError = null;
    this.lastSkip = null;        // {waktu, alasan}
    this.stats = { runs: 0, sent: 0, failed: 0, skipped: 0 };
    this._cache = null;          // {kunci, penjualan, errors}
    this._groupTidakDikenal = [];
  }

  /* --------------------------- pengaturan --------------------------- */

  /** Nilai dari tabel settings bila ada, kalau tidak dari .env. */
  _setting(kunci, bawaan) {
    if (!this.db) return bawaan;
    const v = this.db.getSetting(kunci, null);
    return (v === null || v === undefined || v === '') ? bawaan : v;
  }

  /** Seluruh pengaturan efektif, siap dipakai. */
  opsi() {
    const d = this.dasar;
    const off = (this.config.ocs && this.config.ocs.tzOffsetMinutes) || 420;
    return {
      hours: StockScheduler.parseJam(this._setting(KUNCI.hours, d.hours.join(','))),
      ambang: Math.max(0, parseInt(this._setting(KUNCI.ambang, d.ambang), 10) || 0),
      doiMax: Math.max(0, parseFloat(this._setting(KUNCI.doiMax, d.doiMax)) || 0),
      minAvg: Math.max(0, parseFloat(this._setting(KUNCI.minAvg, d.minAvg)) || 0),
      top: Math.max(1, parseInt(this._setting(KUNCI.top, d.top), 10) || 20),
      kategori: String(this._setting(KUNCI.kategori, d.kategori)),
      avgMode: String(this._setting(KUNCI.avgMode, d.avgMode)).toLowerCase(),
      salesDays: Math.max(7, parseInt(this._setting(KUNCI.salesDays, d.salesDays), 10) || 90),
      groupIds: StockScheduler.parseDaftar(this._setting(KUNCI.groups, d.groupIds.join(','))),
      hanyaAktif: d.hanyaAktif,
      area: d.area,
      chunkDays: d.chunkDays,
      platform: d.platform,
      shop: d.shop,
      persentil: d.persentil,
      paydayMulai: d.paydayMulai,
      detail: d.detail,
      judul: d.judul,
      tzOffsetMinutes: off,
      tzLabel: (this.config.ocs && this.config.ocs.tzLabel) || 'WIB',
    };
  }

  static parseJam(raw) {
    const jam = String(raw || '').split(',')
      .map((s) => parseInt(String(s).trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23);
    return Array.from(new Set(jam)).sort((a, b) => a - b);
  }

  static parseDaftar(raw) {
    return String(raw || '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }

  enabled() {
    const v = this.db ? this.db.getSetting(KUNCI.enabled, null) : null;
    if (v !== null && v !== undefined && v !== '') return String(v) === '1';
    return this.dasar.enabled === true;
  }

  setEnabled(on) {
    if (this.db) this.db.setSetting(KUNCI.enabled, on ? '1' : '0');
    logger.info('Laporan stok', on ? 'DIAKTIFKAN' : 'DIMATIKAN');
  }

  /** Simpan satu pengaturan. Mengembalikan pesan konfirmasi. */
  setOpsi(nama, nilai) {
    const kunci = KUNCI[nama];
    if (!kunci) throw new Error(`pengaturan "${nama}" tidak dikenal`);
    if (nama === 'hours') {
      const jam = StockScheduler.parseJam(nilai);
      if (jam.length === 0) throw new Error('isi jam 0-23 dipisah koma, contoh: 8,12,16');
      this.db.setSetting(kunci, jam.join(','));
      return `Jam kirim: ${jam.map((j) => `${String(j).padStart(2, '0')}:00`).join(', ')}`;
    }
    if (nama === 'doiMax' || nama === 'minAvg') {
      const n = parseFloat(String(nilai).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0) throw new Error('isi dengan angka 0 atau lebih');
      this.db.setSetting(KUNCI[nama], String(n));
      return nama === 'doiMax'
        ? (n > 0 ? `Tampilkan SKU dengan DOI di bawah ${n} hari` : 'Saringan DOI dimatikan')
        : (n > 0 ? `Abaikan SKU yang lakunya di bawah ${n}/hari` : 'Tidak ada batas minimum penjualan');
    }
    if (nama === 'ambang' || nama === 'top' || nama === 'salesDays') {
      const n = parseInt(String(nilai).replace(/[.,\s]/g, ''), 10);
      const bolehNol = nama === 'ambang';
      if (!Number.isFinite(n) || n < 0 || (!bolehNol && n === 0)) {
        throw new Error(bolehNol ? 'isi dengan angka 0 atau lebih (0 = tanpa batas jumlah)'
          : 'isi dengan angka lebih dari 0');
      }
      this.db.setSetting(kunci, String(n));
      if (nama === 'ambang' && n === 0) return 'Batas jumlah stok dimatikan - saringannya murni DOI.';
      return `${nama} = ${angka(n)}`;
    }
    if (nama === 'avgMode') {
      const m = String(nilai).trim().toLowerCase();
      if (!['winsor', 'full', 'normal', 'median'].includes(m)) {
        throw new Error('pilih: winsor, full, normal, atau median');
      }
      this.db.setSetting(kunci, m);
      return `Mode rata-rata: ${m}`;
    }
    if (nama === 'groups') {
      const daftar = StockScheduler.parseDaftar(nilai);
      this.db.setSetting(kunci, daftar.join(','));
      return daftar.length === 0
        ? 'Group tujuan: SEMUA group aktif'
        : `Group tujuan: ${daftar.join(', ')}`;
    }
    if (nama === 'kategori') {
      this.db.setSetting(kunci, String(nilai).trim());
      return `Kategori: ${String(nilai).trim()}`;
    }
    throw new Error(`pengaturan "${nama}" tidak bisa diubah dari sini`);
  }

  /**
   * PIC laporan stok - daftar datar, TIDAK dipecah per shop.
   * Terpisah dari PIC lock stock, jadi boleh orang yang berbeda.
   */
  picList() {
    try {
      const mentah = this._setting(KUNCI.pic, '');
      if (mentah) return normalisasiPic(JSON.parse(mentah));
    } catch (err) {
      logger.warn('Pengaturan PIC laporan stok rusak, diabaikan:', err.message);
    }
    return [];
  }

  static pisahKoma(teks) {
    return String(teks || '').split(',').map((x) => x.trim()).filter(Boolean);
  }

  setPicNama(nama) {
    const baru = StockScheduler.pisahKoma(nama);
    if (baru.length === 0) {
      this.db.setSetting(KUNCI.pic, '');
      return 'PIC laporan stok dikosongkan - pesan dikirim tanpa sapaan.';
    }
    const lama = this.picList();
    const hasil = baru.map((n, i) => ({ nama: n, nomor: (lama[i] && lama[i].nomor) || '' }));
    this.db.setSetting(KUNCI.pic, JSON.stringify(hasil));
    return `PIC laporan stok (${hasil.length} orang):\n`
      + hasil.map((p, i) => `  ${i + 1}. ${p.nama}${p.nomor ? ` (@${p.nomor})` : ' - belum ada nomor'}`).join('\n');
  }

  setPicNomor(nomor) {
    const daftar = this.picList();
    if (daftar.length === 0) throw new Error('belum ada PIC. Isi namanya dulu dengan /stokpic');
    const mentah = String(nomor || '').trim();
    if (mentah === '' || /^(hapus|kosong|-)$/i.test(mentah)) {
      const kosong = daftar.map((p) => ({ ...p, nomor: '' }));
      this.db.setSetting(KUNCI.pic, JSON.stringify(kosong));
      return 'Semua nomor PIC laporan stok dihapus - namanya tetap disapa, tanpa mention.';
    }
    const potongan = StockScheduler.pisahKoma(mentah);
    if (potongan.length > daftar.length) {
      throw new Error(`ada ${potongan.length} nomor tetapi hanya ${daftar.length} nama PIC. `
        + 'Tambahkan namanya dulu dengan /stokpic');
    }
    const bersih = [];
    for (const [i, n] of potongan.entries()) {
      if (/^(kosong|-)$/i.test(n)) { bersih.push(''); continue; }
      const cek = validateWhatsappNumber(n);
      if (!cek.ok) throw new Error(`nomor ke-${i + 1} ("${n}"): ${cek.error}`);
      bersih.push(cek.value);
    }
    const hasil = daftar.map((p, i) => ({ ...p, nomor: i < bersih.length ? bersih[i] : p.nomor }));
    this.db.setSetting(KUNCI.pic, JSON.stringify(hasil));
    return `PIC laporan stok:\n`
      + hasil.map((p, i) => `  ${i + 1}. ${p.nama}${p.nomor ? ` (@${p.nomor})` : ' - belum ada nomor'}`).join('\n');
  }

  /* ---------------------------- penjadwal --------------------------- */

  /** Kunci unik "2026-08-28:08" supaya satu jam hanya terkirim sekali. */
  _kunciJam(now, off, jam) {
    return `${kunciHari(now, off)}:${String(jam).padStart(2, '0')}`;
  }

  /**
   * Jam kirim yang jatuh tempo sekarang, atau null.
   * Ada toleransi beberapa menit supaya laporan tetap terkirim walau
   * aplikasi baru hidup pukul 08:03.
   */
  jatuhTempo(now = new Date(), toleransiMenit = 10) {
    const o = this.opsi();
    if (o.hours.length === 0) return null;
    const l = new Date(now.getTime() + o.tzOffsetMinutes * 60000);
    const jam = l.getUTCHours();
    const menit = l.getUTCMinutes();
    if (!o.hours.includes(jam)) return null;
    if (menit > toleransiMenit) return null;
    const kunci = this._kunciJam(now, o.tzOffsetMinutes, jam);
    if (this.db && this.db.getSetting(KUNCI.lastFired, '') === kunci) return null;
    return { jam, kunci };
  }

  start() {
    if (this.timer) return;
    const o = this.opsi();
    logger.info(
      o.hours.length > 0
        ? `Laporan stok dijadwalkan pukul ${o.hours.map((j) => `${String(j).padStart(2, '0')}:00`).join(', ')} ${o.tzLabel}.`
        : 'Laporan stok: belum ada jam kirim yang disetel.'
    );
    if (o.hours.length > 0 && !this.enabled()) {
      logger.warn('Tombol laporan stok sedang MATI - jam kirim tidak akan menghasilkan apa pun. '
        + 'Nyalakan dengan /stokon.');
    }
    this.timer = setInterval(() => {
      const tempo = this.jatuhTempo();
      if (!tempo) return;
      // Jam kirimnya sudah tiba. Kalau tetap tidak dikirim, katakan
      // alasannya - jangan diam, karena gejalanya jadi tidak bisa dilacak.
      if (!this.enabled()) {
        this._catatDilewati('tombol MATI - nyalakan dengan /stokon');
        return;
      }
      if (this.db) this.db.setSetting(KUNCI.lastFired, tempo.kunci);
      this.runOnce().catch((err) => logger.error('Laporan stok gagal:', err.message));
    }, 60000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /* -------------------------- satu putaran -------------------------- */

  async runOnce({ paksa = false } = {}) {
    if (this.running) {
      this.stats.skipped += 1;
      logger.warn('Putaran laporan stok sebelumnya belum selesai - dilewati.');
      return { status: 'skipped', reason: 'sedang berjalan' };
    }
    if (!paksa && !this.enabled()) {
      this.stats.skipped += 1;
      this._catatDilewati('tombol MATI - nyalakan dengan /stokon');
      return { status: 'skipped', reason: 'dimatikan' };
    }

    this.running = true;
    this.lastRunAt = Date.now();
    this.stats.runs += 1;
    try {
      const data = await this.ambilData();
      const pesan = this.susunPesan(data);
      const groups = await this.kirim(pesan);
      this.lastOkAt = Date.now();
      this.lastError = null;
      return { status: 'sent', text: pesan.text, groups, jumlah: data.baris.length };
    } catch (err) {
      this.stats.failed += 1;
      this.lastError = err.message;
      logger.error('Laporan stok gagal:', err.message);
      this._notify(`Laporan stok gagal: ${err.message}`);
      return { status: 'failed', reason: err.message };
    } finally {
      this.running = false;
    }
  }

  /**
   * Ambil stok + penjualan lalu gabungkan.
   * Data penjualan di-cache per jendela tanggal, sehingga tiga laporan
   * dalam satu hari hanya menarik data berat itu SEKALI.
   */
  async ambilData(opsiTambahan = {}) {
    const o = { ...this.opsi(), ...opsiTambahan };
    const now = opsiTambahan.now || new Date();
    const rentang = rentangPenjualan(now, o.tzOffsetMinutes, o.salesDays);
    let hariList = daftarHari(rentang.from, rentang.to, o.tzOffsetMinutes);

    const errors = [];

    const stokMentah = await this.client.fetchLowStock({
      ambang: o.ambang, kategori: o.kategori, hanyaAktif: o.hanyaAktif, area: o.area,
    });
    const stok = saringStok(stokMentah, o);

    const kunciCache = `${rentang.from}|${rentang.to}|${o.platform}|${o.shop}|${o.area}`;
    let penjualan;
    if (this._cache && this._cache.kunci === kunciCache) {
      penjualan = this._cache.penjualan;
      errors.push(...this._cache.errors);
      logger.debug('Data penjualan diambil dari cache.');
    } else {
      const hasil = await this.client.fetchOrderPerSkuRange({
        from: rentang.from, to: rentang.to, chunkDays: o.chunkDays,
        platform: o.platform, shop: o.shop, area: o.area || 'All',
      });
      penjualan = deretHarian(hasil.baris, o.tzOffsetMinutes);
      errors.push(...hasil.errors);
      // Pembagi hanya memuat hari yang datanya benar-benar sampai.
      const hariNyata = daftarHariGabungan(hasil.berhasil || [], o.tzOffsetMinutes);
      this._cache = {
        kunci: kunciCache, penjualan, errors: hasil.errors, hariNyata,
      };
      logger.info(`Penjualan: ${hasil.baris.length} baris, ${penjualan.size} SKU, `
        + `${hariNyata.length} dari ${hariList.length} hari berhasil ditarik.`);
    }
    const hariNyata = this._cache.hariNyata;
    if (hariNyata && hariNyata.length > 0 && hariNyata.length < hariList.length) {
      logger.warn(
        `Hanya ${hariNyata.length} dari ${hariList.length} hari yang berhasil ditarik. `
        + 'Rata-rata dihitung memakai hari yang ada saja agar tidak terlalu rendah.'
      );
      hariList = hariNyata;
    }

    const semua = susunBaris(stok, penjualan, hariList, {
      mode: o.avgMode, persentil: o.persentil, paydayMulai: o.paydayMulai,
    });
    const baris = saringDoi(semua, { doiMax: o.doiMax, minAvg: o.minAvg });

    logger.info(
      `Kandidat ${semua.length} SKU (kategori ${o.kategori}), `
      + `${baris.length} memenuhi kriteria: ${kriteria(o, o.ambang)}.`
    );
    return { baris, semua, rentang: { ...rentang, hari: hariList.length }, hariList, errors, opsi: o };
  }

  /** @returns {{text: string, mentions: string[]}} */
  susunPesan(data) {
    const o = data.opsi || this.opsi();
    return renderStockReport(data, {
      now: new Date(),
      tzOffsetMinutes: o.tzOffsetMinutes,
      tzLabel: o.tzLabel,
      top: o.top,
      ambang: o.ambang,
      doiMax: o.doiMax,
      minAvg: o.minAvg,
      kategori: o.kategori,
      mode: o.avgMode,
      persentil: o.persentil,
      detail: o.detail,
      judul: o.judul,
      pic: this.picList(),
      denganMention: true,
    });
  }

  /** Group tujuan - aturannya sama dengan laporan Fulfilment. */
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
    const teks = typeof pesan === 'string' ? pesan : pesan.text;
    const mentions = typeof pesan === 'string' ? [] : (pesan.mentions || []);
    const groups = this.targetGroups();
    if (groups.length === 0) {
      if (this._groupTidakDikenal.length > 0) {
        throw new Error(`tujuan tidak dikenal: ${this._groupTidakDikenal.join(', ')}. `
          + 'Isi dengan JID (contoh 1203...@g.us) atau nama group yang terdaftar di /groups.');
      }
      throw new Error('belum ada WhatsApp Group aktif (buka /groups)');
    }
    if (!this.wa.isReady()) throw new Error('WhatsApp belum tersambung');

    let terkirim = 0;
    const gagal = [];
    for (const group of groups) {
      try {
        await this.queue.enqueue(() => this.wa.sendText(group.id, teks, mentions), `laporan stok -> ${group.name}`);
        terkirim += 1;
      } catch (err) {
        gagal.push(`${group.name}: ${err.message}`);
        logger.error(`Laporan stok gagal dikirim ke "${group.name}": ${err.message}`);
      }
    }
    if (terkirim === 0) throw new Error(`gagal ke seluruh group. ${gagal.join(' | ')}`);
    if (gagal.length > 0) this._notify(`Laporan stok terkirim ke ${terkirim}/${groups.length} group. Gagal: ${gagal.join(' | ')}`);
    this.stats.sent += 1;
    logger.info(`Laporan stok terkirim ke ${terkirim} group.`);
    return terkirim;
  }

  ringkasanStatus() {
    const o = this.opsi();
    const off = o.tzOffsetMinutes;
    const B = [];
    B.push(`Laporan stok: ${this.enabled() ? 'AKTIF' : 'MATI'}`);
    B.push(o.hours.length > 0
      ? `Jam kirim: ${o.hours.map((j) => `${String(j).padStart(2, '0')}:00`).join(', ')} ${o.tzLabel}`
      : 'Jam kirim: belum disetel');
    B.push(`Kriteria: ${kriteria(o, o.ambang)}`);
    B.push(`Kategori: ${o.kategori}`);
    const pic = this.picList();
    B.push(`PIC: ${pic.length === 0 ? '(belum diisi - pesan tanpa sapaan)'
      : pic.map((p) => `${p.nama}${p.nomor ? ` (@${p.nomor})` : ' [tanpa nomor]'}`).join(', ')}`);
    B.push(`Rata-rata: ${o.salesDays} hari, mode ${o.avgMode}`);
    B.push(`Tampilkan: ${o.top} SKU teratas`);
    B.push(`Group tujuan: ${o.groupIds.length === 0 ? 'semua group aktif' : o.groupIds.join(', ')}`);
    B.push(`Penjadwal: ${this.timer ? 'jalan' : 'TIDAK JALAN'}`);
    B.push(`Terakhir dijalankan: ${this.lastRunAt ? jamLokal(new Date(this.lastRunAt), off, o.tzLabel) : '-'}`);
    B.push(`Terakhir berhasil: ${this.lastOkAt ? jamLokal(new Date(this.lastOkAt), off, o.tzLabel) : '-'}`);
    if (this.lastSkip) {
      B.push(`Terakhir dilewati: ${jamLokal(new Date(this.lastSkip.waktu), off, o.tzLabel)} - ${this.lastSkip.alasan}`);
    }
    if (o.hours.length === 0) {
      B.push('');
      B.push('CATATAN: jam kirim belum disetel, jadi tidak akan pernah terkirim otomatis.');
      B.push('Setel dengan /stokjam 8,12,16');
    } else if (!this.enabled()) {
      B.push('');
      B.push('CATATAN: tombol sedang MATI. Nyalakan jadwal dengan /stokon.');
    }
    B.push(`Terkirim: ${this.stats.sent} | gagal: ${this.stats.failed} | dilewati: ${this.stats.skipped}`);
    if (this.lastError) B.push(`Galat terakhir: ${this.lastError}`);
    return B.join('\n');
  }

  _catatDilewati(alasan) {
    this.lastSkip = { waktu: Date.now(), alasan };
    logger.info(`Laporan stok dilewati: ${alasan}.`);
  }

  _notify(text) {
    if (typeof this.notifyAdmins === 'function') {
      try { this.notifyAdmins(text); } catch (e) { /* diabaikan */ }
    }
  }
}

module.exports = StockScheduler;
module.exports.KUNCI = KUNCI;
